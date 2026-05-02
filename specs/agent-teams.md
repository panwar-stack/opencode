# Agent Teams Proposal

## Status

Proposal for design review and contribution planning.

Agent teams are an experimental multi-agent orchestration feature. The goal of this document is to make the intended behavior reviewable before the feature is treated as stable user-facing functionality.

Reference implementation: https://github.com/panwar-stack/opencode/commit/c9196991a16f2386f1d83d8deebf94097fb097f0 

## Summary

Agent teams let one OpenCode lead session create and coordinate multiple background teammate sessions. Each teammate is a normal child session with its own agent type, prompt, status, mailbox, optional dependencies, and optional plan approval.

The feature is enabled explicitly:

```json
{
  "experimental": {
    "agent_teams": true
  }
}
```

Once enabled, the lead agent can use team tools to create a team, spawn teammates, route messages, track shared tasks, approve plans, and shut down the team.

## Problem

The existing subagent model is useful for isolated delegated tasks, but it does not provide durable coordination primitives. Complex work often needs:

- multiple agents running in parallel
- explicit handoffs between agents
- dependency ordering between pieces of work
- a way for child sessions to communicate with the lead
- progress visibility in the TUI
- a controlled planning gate before a teammate can mutate files

Without these primitives, orchestration is encoded in prompts and final answers, which makes coordination brittle and hard to review.

## Goals

- Allow one lead session to coordinate a bounded set of teammate sessions.
- Keep teammates as normal child sessions so existing session storage, permissions, navigation, and cancellation still apply.
- Support non-blocking teammate spawning.
- Support dependency-based start ordering between teammates.
- Provide a mailbox for lead-to-teammate and teammate-to-teammate communication.
- Provide a shared task list for lightweight work tracking.
- Support plan approval mode for review-before-write workflows.
- Surface team status, pending permissions, tasks, and messages in the TUI.
- Keep the feature behind `experimental.agent_teams` until the behavior is stable.

## Non-goals

- Replacing normal subagents or the Task tool.
- Running arbitrary remote workers.
- Guaranteeing deterministic multi-agent execution.
- Solving merge conflicts between teammates automatically.
- Adding organization/workspace membership semantics.
- Making the shared task list a scheduler by itself.

## User Experience

### Create a team

The lead session creates one active team:

```txt
Use agent teams. Create a team named api-refactor to split exploration,
implementation, and review.
```

Only one active team can exist per lead session. A closed team should allow a new team to be created for the same lead session.

### Spawn teammates

The lead spawns teammates with a name, agent type, and role prompt:

```txt
Spawn an explorer teammate to inspect auth routes.
Spawn an implementer teammate that waits for the explorer.
```

The spawn should return immediately with teammate metadata while the child session runs in the background.

### Coordinate work

Team members communicate through mailbox messages. Recipients can be:

- `lead`
- teammate name
- teammate session ID
- comma-separated recipients

Teammates should send kickoff, progress, blocker, handoff, and completion updates through the mailbox.

### Track tasks

The shared task list records team-level work:

- `pending`
- `in_progress`
- `completed`
- `cancelled`

Task dependencies gate claiming, but creating a task does not spawn or wake an agent.

### Approve plans

A teammate can start in plan mode. In plan mode, mutating tools are denied until the lead approves the submitted plan.

Plan mode blocks:

- `bash`
- `write`
- `edit`
- `apply_patch`

Approving a plan removes the deny rules and wakes the teammate. Rejecting a plan sends feedback and keeps the teammate in plan mode.

### Shut down

Shutting down a team closes the team and cancels active teammate sessions. It does not cancel the lead session.

## Tools

| Tool | Purpose |
| ---- | ------- |
| `team_create` | Create the active team for the current lead session. |
| `team_spawn` | Spawn a non-blocking teammate child session. |
| `team_send_message` | Send mailbox messages to one or more recipients. |
| `team_broadcast` | Send one message to all active teammates, and to the lead when called by a teammate. |
| `team_get_messages` | Read pending mailbox messages for the current team session. |
| `team_task_create` | Create a shared task record. |
| `team_task_list` | List team tasks. |
| `team_task_claim` | Claim a pending task after dependencies are complete. |
| `team_task_update` | Update task status or assignee. |
| `team_plan_submit` | Submit a teammate plan to the lead. |
| `team_plan_decide` | Approve or reject a teammate plan. |
| `team_shutdown` | Close the active team and cancel active teammates. |

## Data Model

The feature needs four persisted concepts:

### Team

- `id`
- `name`
- `goal`
- `lead_session_id`
- `status`: `active`, `closed`, `cancelled`
- timestamps

Constraint: one active team per `lead_session_id`.

### Team member

- `id`
- `team_id`
- `session_id`
- `name`
- `agent_type`
- `model`
- `role_prompt`
- `status`: `starting`, `blocked`, `active`, `idle`, `completed`, `cancelled`
- `plan_mode`
- `work_mode`: `plan`, `implement`
- `dependency_ids`
- `result`
- timestamps

Constraint: one team member per child `session_id`.

### Team task

- `id`
- `team_id`
- `description`
- `status`: `pending`, `in_progress`, `completed`, `cancelled`
- `assignee`
- `dependency_ids`
- `metadata`
- timestamps

### Team message

- `id`
- `team_id`
- `sender`
- `recipients`
- `body`
- `delivery_status`: `pending`, `delivered`, `read`
- timestamps

Message recipients should be tracked separately so each recipient can have its own delivery state.

## HTTP API

The server should expose enough team state for clients to display and manage teams:

```txt
GET  /team?sessionID=<sessionID>   -> TeamInfo
GET  /team/:teamID                 -> TeamInfo
GET  /team/:teamID/tasks           -> TeamTask[]
GET  /team/:teamID/messages        -> TeamMessage[]
POST /team/:teamID/shutdown        -> boolean
```

If these endpoints change, regenerate the SDK after updating the OpenAPI surface.

## TUI

The TUI should expose team state without forcing users to inspect child sessions manually.

Required surfaces:

- sidebar team section with teammate count, status, and pending permission/question count
- team panel with overview, tasks, and messages tabs
- shutdown action
- child-session navigation for teammate sessions

Default team keybinds:

| Keybind | Default | Purpose |
| ------- | ------- | ------- |
| `team_panel_toggle` | `<leader>v` | Open the team panel. |
| `team_task_list` | `<leader>k` | Open the team panel on tasks. |
| `team_cycle_lead` | `<leader>up` | Navigate from a teammate to the lead session. |

## Permissions and Safety

- The feature must remain behind `experimental.agent_teams`.
- Teammates should inherit parent deny rules and external-directory protection.
- Plan mode must deny mutating tools until explicit lead approval.
- Team shutdown must cancel active teammate runs.
- Mailbox delivery should wake idle sessions when prompt operations are available.
- The lead should receive automatic start, blocked, completed, idle, and cancelled updates.

## Contribution Plan

Review and contribution can be split into small PRs:

1. Core team service
   - schema tables
   - team create/get/shutdown
   - member lifecycle
   - messages and recipients
   - tasks and dependencies

2. Team tools
   - create, spawn, messaging, tasks, plan approval, shutdown
   - clear disabled-state output when `experimental.agent_teams` is false
   - dependency resolution by teammate name or session ID

3. Prompt integration
   - deliver pending mailbox messages as synthetic user context
   - mark delivered messages after insertion
   - preserve normal session loop behavior

4. TUI integration
   - sidebar teammate status
   - team panel
   - team keybinds
   - pending permission/question visibility

5. HTTP API and SDK
   - team read endpoints
   - shutdown endpoint
   - OpenAPI annotations
   - SDK regeneration

6. Documentation
   - user guide
   - server API docs
   - keybind docs
   - config docs

## Testing Plan

Run tests from package directories, not the repo root.

Core tests in `packages/opencode` should cover:

- creating a team
- rejecting duplicate active teams for the same lead
- creating a new team after shutdown
- adding and listing members
- updating member status
- creating, claiming, and updating tasks
- blocking task claims until dependencies complete
- sending and delivering messages per recipient
- shutdown cancellation behavior

Tool tests should cover:

- disabled config behavior
- missing active team behavior
- unknown agent type
- missing dependencies
- blocked teammates starting after dependency completion
- plan submit and decide flow
- mailbox wake behavior when prompt operations exist

TUI tests should cover:

- team sidebar plugin registration
- team sidebar active state when `experimental.agent_teams` is true
- plugin disabled state when the internal team plugin is disabled

Suggested verification commands:

```bash
cd packages/opencode
bun test test/team test/tool/team_spawn.test.ts test/cli/tui/plugin-team.test.ts
bun typecheck
```

If the SDK changes:

```bash
./packages/sdk/js/script/build.ts
```

## Review Checklist

- Does the feature add enough value over existing subagents to justify new primitives?
- Are lead and teammate responsibilities clear?
- Are tool names and arguments understandable to models and users?
- Is plan mode restrictive enough before approval?
- Is shutdown behavior predictable?
- Is mailbox delivery state sufficient for multiple recipients?
- Are task dependencies intentionally lightweight, or do they need scheduler semantics?
- Are HTTP endpoints read-only except shutdown?
- Is the experimental gate strict enough?
- Are docs clear that this is agent orchestration, not workspace/team membership?

## Open Questions

- Should `team_spawn` expose model override arguments, or only use the selected agent's configured model?
- Should completed teammate results be summarized before sending to the lead for very long outputs?
- Should task updates enforce lead-or-assignee authorization, or is model-level guidance enough?
- Should messages support `read` separately from `delivered`, or is one delivered state sufficient?
- Should teams survive process restarts and resume blocked/running teammate state, or should active runs be treated as ephemeral?
- Should team APIs expose members directly, or should clients continue deriving members from child sessions?
- Should team tools be hidden from non-team sessions until a team exists?

## Stability Criteria

Agent teams can graduate from experimental when:

- the team data model has no known migration blockers
- the TUI can show all important team state
- teammate cancellation and plan approval are reliable
- mailbox delivery behaves consistently across lead and teammate sessions
- API and SDK shapes are stable
- docs include user-facing examples and limitations
