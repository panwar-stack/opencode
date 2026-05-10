# Agent Teams Developer Guide

This guide explains the agent team system from the implementation side.

The short version: one normal OpenCode session becomes the **lead**, and every teammate is a **child session** registered as a team member. Coordination happens through tool calls, persisted team tables, mailbox messages, dependency checks, and the normal session prompt loop.

## Mental Model

Agent teams are not a separate runtime.

They are built on top of the existing session system:

- the lead is a regular session
- each teammate is a regular child session
- each teammate runs through the normal prompt loop
- team tools are normal model tools
- coordination state is stored in SQLite tables
- mailbox delivery is injected back into sessions as synthetic user messages

So when you read the code, do not look for a central "team scheduler" that owns every step. Most behavior is the lead or teammate model choosing tools, and the team service recording and routing state.

## Important Files

- `src/team/team.sql.ts`: database schema for teams, members, tasks, messages, and per-recipient delivery.
- `src/team/team.ts`: core service for creating teams, adding members, updating status, tasks, messages, and shutdown.
- `src/tool/team_create.ts`: tool that makes the current session the lead.
- `src/tool/team_spawn.ts`: tool that creates and runs teammate child sessions.
- `src/tool/team_send_message.ts`: direct mailbox messages.
- `src/tool/team_broadcast.ts`: mailbox broadcast to active participants.
- `src/tool/team_get_messages.ts`: explicit mailbox read tool.
- `src/tool/team_plan_submit.ts`: teammate submits a plan to the lead.
- `src/tool/team_plan_decide.ts`: lead approves or rejects a plan.
- `src/session/prompt.ts`: prompt loop integration that injects pending team messages.
- `src/tool/registry.ts`: enables team tools when `experimental.agent_teams` is true.

## Who Is The Lead?

The lead is the session that calls `team_create`.

`team_create` calls `team.create` with `leadSessionID: ctx.sessionID`. That value is stored on the `team` row as `lead_session_id`.

There is only one active team per lead session. The schema enforces this with a unique partial index on active `lead_session_id`, and `team.create` also checks before inserting.

The lead is responsible for:

- creating the team
- spawning teammates
- receiving start, waiting, completion, and blocker updates
- approving or rejecting plan-mode work
- coordinating follow-up work
- shutting down the team when needed

The lead is still just a normal assistant session. It does these things by choosing team tools in response to the user's request.

## Who Are The Workers?

Workers are called teammates in the code and docs.

A teammate is a child session plus a row in `team_member`.

`team_spawn` creates the child session with:

```ts
sessions.create({
  parentID: ctx.sessionID,
  title: `${params.name} (@${ag.name} teammate)`,
  permission: permissionRules,
})
```

Then it calls `team.addMember` to store:

- team ID
- child session ID
- teammate name
- agent type
- model
- role prompt
- status
- plan mode flag
- work mode
- dependency session IDs
- final result

The child session is what actually runs the model. The team member row is the coordination record for that session.

## How The Lead Calls `team_spawn`

`team_spawn` is exposed to the lead model as a normal tool.

The path is:

1. `ToolRegistry` checks config.
2. If `experimental.agent_teams === true`, it includes `team_spawn` and the other team tools.
3. `SessionPrompt.resolveTools` exposes those tools to the model during the lead session prompt loop.
4. The lead model emits one `team_spawn` tool call per teammate it wants.
5. The tool dispatcher calls `item.execute(args, ctx)`.
6. `team_spawn` uses `ctx.sessionID` as the lead session ID.

Example model-level intent:

```json
{ "name": "auth-explorer", "agent_type": "explore", "role_prompt": "Inspect auth flow" }
{ "name": "api-explorer", "agent_type": "explore", "role_prompt": "Inspect API routes" }
{ "name": "implementer", "agent_type": "general", "role_prompt": "Implement after findings", "depends_on": ["auth-explorer", "api-explorer"] }
```

Those are just separate tool calls. Independent calls can happen in parallel. Dependent teammates are created but blocked until their dependencies finish.

## What `team_spawn` Does

`team_spawn` is the main orchestration entry point.

The flow is:

1. Read config and stop if agent teams are disabled.
2. Find the active team for `ctx.sessionID`.
3. Validate the requested `agent_type`.
4. Require `promptOps`; without it, a teammate cannot actually run.
5. Resolve `depends_on` / `wait_for` names into teammate session IDs.
6. Create a child session under the lead.
7. Insert a `team_member` row with status `starting`.
8. Notify active dependency teammates if someone is waiting on them.
9. If dependencies are incomplete, mark the new teammate `blocked`.
10. If dependencies are complete, start the teammate and wait for its current run to finish.

Starting a teammate means building a prompt that includes:

- teammate identity
- team goal
- lead session ID
- teammate session ID
- available team tools
- current teammates
- communication rules
- dependency results, if any
- the role prompt from the lead

Then `ops.prompt` runs the child session with the selected agent and model.

## Lead Waiting And Parallel Spawn

Running teammates block the lead's current assistant step.

`team_spawn` waits for the teammate's current run and returns the teammate result to the lead. This matches the older `task` tool strategy: while delegated work is running, the lead session stays busy instead of continuing to reason over unknown future outputs.

The lead can still start multiple teammates in parallel by emitting multiple `team_spawn` tool calls in the same assistant step. The AI SDK executes sibling tool calls concurrently, so each `team_spawn` call waits for its own teammate while the overall step remains blocked until all sibling calls complete.

Inside the teammate run:

1. Member status becomes `active`.
2. Lead gets an automatic "teammate started" message.
3. The child session receives its assignment prompt.
4. The teammate runs through the normal session prompt pipeline.
5. When the teammate finishes, the last text result is extracted.
6. The lead gets an automatic completion message containing the result.
7. Member status becomes `completed`.
8. Any blocked teammates that depended on this session are checked and possibly started.

When a completed teammate unblocks multiple dependents, those newly ready teammates are started concurrently. The lead resumes after the relevant running teammates finish, then it can integrate results and decide the next coordination step.

## Dependencies

Dependencies are teammate-level dependencies, not task-list dependencies.

`team_spawn` accepts:

- `depends_on`
- `wait_for`

Both are resolved against existing teammate names or session IDs.

If a dependency is missing, spawn fails. If a dependency exists but is not completed, the new member is marked `blocked`.

When a teammate completes, `startReadyBlockedMembers` checks blocked members that reference the completed session. A blocked member starts only when every dependency session has status `completed`.

When it starts, the dependency results are injected into the prompt under `Dependency results:`.

## Mailbox Coordination

The mailbox is the main communication mechanism.

Messages are stored in:

- `team_message`: one row per logical message
- `team_message_recipient`: one row per recipient, with independent delivery status

This per-recipient table matters. A message sent to two teammates can be delivered to one while still pending for the other.

Common tools:

- `team_send_message`: send to `lead`, teammate name, teammate session ID, or comma-separated recipients
- `team_broadcast`: send to the lead and active teammates except the sender
- `team_get_messages`: explicitly read pending messages for the current session

Sending a message also tries to wake recipients through `wakeTeamSession`.

## How Waking Works

Waking is intentionally simple.

`wakeTeamSession` calls `ops.loop` twice for the target session. This nudges an idle recipient session to continue its normal prompt loop.

The actual delivery happens in `SessionPrompt.deliverTeamMessages`:

1. Get team context for the current session.
2. Read pending messages for that session.
3. Create a synthetic user message.
4. Put the pending mailbox content inside a `<team-messages>` block.
5. Mark those recipient rows delivered.
6. Continue the prompt loop.

So a teammate does not need to poll forever. If another participant sends a message, the recipient is woken and sees the message as a normal prompt input on the next loop.

## Plan Mode

Plan mode is a guardrail for teammates that should not edit immediately.

When `team_spawn` receives `plan_mode: true`, it adds deny rules for:

- `bash`
- `write`
- `edit`
- `apply_patch`

The teammate also receives the `team_plan_submit` tool in its prompt instructions.

The flow is:

1. Teammate starts with mutating tools denied.
2. Teammate calls `team_plan_submit`.
3. The lead receives a mailbox message with the plan.
4. Lead calls `team_plan_decide`.
5. If approved, deny rules are removed from the child session permissions.
6. The teammate is messaged and woken.
7. If rejected, feedback is sent and the teammate stays in plan mode.

Plan mode is not a separate model mode. It is implemented with session permission rules plus mailbox coordination.

## Shared Tasks

Shared tasks are separate from teammate dependencies.

They live in `team_task` and are manipulated by:

- `team_task_create`
- `team_task_list`
- `team_task_claim`
- `team_task_update`

Creating a task only records tracking state. It does not spawn or wake a teammate.

Claiming a task enforces task dependency IDs. A pending task cannot be claimed until all dependency tasks are completed or cancelled.

Use this for shared work tracking inside a team. Use `depends_on` / `wait_for` when one teammate should not start until another teammate completes.

## Status Events And UI

The service publishes bus events for team lifecycle and member updates:

- `team.created`
- `team.closed`
- `team.member.updated`
- `team.message.received`

The TUI sidebar lists child sessions for the current parent session. That means older `task` subagents and team teammates can appear in the same Team section because both are child sessions. `team_member_status` is keyed by session ID and adds team-specific status for teammate children; plain subagents do not have a `team_member` row.

The UI does not orchestrate work. It reads state, shows members/tasks/messages, displays pending permissions/questions, and can call shutdown.

## Shutdown

`team_shutdown` only works from the lead session because it looks up the active team by `ctx.sessionID`.

Shutdown:

- marks the team `closed`
- marks non-finished members `cancelled`
- cancels active member session run state
- publishes `team.closed`
- does not cancel the lead session

## HTTP API

The HTTP API is read-heavy:

- `GET /team?sessionID=<session>`: get active team by lead session
- `GET /team/:teamID`: get team by ID
- `GET /team/:teamID/tasks`: list tasks
- `GET /team/:teamID/messages`: list messages
- `POST /team/:teamID/shutdown`: shut down team

Tool calls are still the primary way models create teams, spawn teammates, and coordinate.

## Common Misreadings

`team_spawn` is not the same as the older `task` tool.

The `task` tool runs a subagent-style task and returns a result to the current session. `team_spawn` creates a persistent child session that can receive mailbox messages, have dependencies, be displayed in the TUI, and keep team membership state.

There is no central loop polling all teammates.

Each teammate runs through the normal session prompt loop. Mailbox messages wake sessions. Dependencies are checked when a dependency completes.

The lead is not special at the session layer.

The lead is special because the team row points to its session ID. The lead still uses normal tools and normal prompt processing.

Tasks do not start teammates.

The shared task list is bookkeeping. Spawning and dependency orchestration happen through `team_spawn`.

## Debugging Path

For "why did spawn fail":

1. Check `experimental.agent_teams`.
2. Check that the current session has an active team.
3. Check that `agent_type` exists.
4. Check that `promptOps` is present.
5. Check dependency names/session IDs.

For "why did a teammate not start":

1. Look at `team_member.status`.
2. If `blocked`, inspect `dependency_ids`.
3. Confirm each dependency member is `completed`.
4. Check whether the background prompt task failed and marked the member `cancelled`.

For "why did a message not arrive":

1. Check `team_message`.
2. Check `team_message_recipient` for the target recipient.
3. Confirm the recipient session ID matches the lead or member session.
4. Check whether `deliverTeamMessages` marked it delivered.
5. Check whether `promptOps` was available to wake the recipient.

## Tests To Read

Good starting tests:

- `test/team/team.test.ts`: service-level team behavior, messages, tasks, plan-mode helpers, shutdown.
- `test/tool/team_spawn.test.ts`: actual spawn behavior, prompt context, dependency blocking, and automatic dependent start.

Run tests from the package directory, not the repo root:

```bash
cd packages/opencode
bun test test/team/team.test.ts
bun test test/tool/team_spawn.test.ts
```

## One-Screen Flow

```txt
user asks for agent team
  |
lead session calls team_create
  |
lead model calls team_spawn once per teammate
  |
team_spawn creates child session + team_member row
  |
if dependencies incomplete:
  member status = blocked
else:
  run child session and wait for teammate result
  |
teammate runs normal prompt loop
  |
teammate sends mailbox updates / uses shared tasks / submits plans
  |
messages wake recipient sessions and inject <team-messages>
  |
teammate finishes
  |
result sent to lead and stored on team_member
  |
dependent blocked teammates may start
  |
lead reports final result or shuts down team
```
