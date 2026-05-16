# Prevent Nested Team Spawning

## Goal

Ensure only primary lead sessions can create and spawn agent teams. Subagents and team members must not be able to call `team_spawn`, including the bypass path where they first call `team_create` to become a lead of a nested team.

Implementation should use the existing permission/tool-filtering path so restricted tools are not model-visible, and add execution guards so direct tool calls fail deterministically.

## Current State

- `src/tool/registry.ts` registers all team tools, including `team_create` and `team_spawn`, whenever `cfg.experimental?.agent_teams === true`.
- `src/session/llm.ts` filters model-visible tools through merged agent/session permissions and user tool overrides.
- `src/session/prompt.ts` omits team lead guidance for subagents, teammates, and child sessions, but this is prompt-only and does not remove tools.
- `src/tool/task.ts` creates subagent sessions and passes a `tools` override that disables `todowrite`, `task`, and `experimental.primary_tools`; it does not disable team tools.
- `src/agent/subagent-permissions.ts` defaults subagents away from `todowrite` and `task`; it does not deny `team_create` or `team_spawn`.
- `src/tool/team_spawn.ts` requires an active team for `ctx.sessionID`, but it does not explicitly verify the caller is a primary lead session.
- `src/tool/team_create.ts` creates a team with `leadSessionID: ctx.sessionID`; it does not reject subagent sessions or existing team members.
- `src/team/team.ts` infers lead/member role from `lead_session_id` and `team_member.session_id`; a session can effectively be a team member of one team and lead of another unless guarded above the storage layer.
- Existing tests cover experimental team-tool registration in `test/tool/registry.test.ts`, subagent tool shaping in `test/tool/task.test.ts`, teammate guidance in `test/session/prompt.test.ts`, and team spawn behavior in `test/tool/team_spawn.test.ts`.

## Non-Negotiables

- Subagents must not see or execute `team_spawn`.
- Teammates must not see or execute `team_spawn`.
- Subagents and teammates must not create their own team as a bypass to call `team_spawn`.
- Primary lead sessions must keep existing `team_create` and `team_spawn` behavior when `experimental.agent_teams` is enabled.
- Existing teammate coordination tools such as `team_send_message`, `team_get_messages`, `team_task_claim`, `team_task_update`, and `team_plan_submit` must remain available where currently supported.
- Do not change the team database schema for the first pass.
- Do not rely on prompt text as the enforcement mechanism.

## Tool Authorization Design

Use two layers of enforcement:

1. Model-visible tool suppression:
   - Subagent sessions should receive deny rules or explicit `tools` overrides for `team_create` and `team_spawn`.
   - Teammate prompt calls should pass explicit tool disables for `team_create` and `team_spawn`.
2. Execution-time guardrails:
   - `TeamCreateTool` must reject calls from subagent sessions, child sessions, and active team members.
   - `TeamSpawnTool` must reject calls from subagent sessions and active team members before spawning any child session.

Recommended restricted orchestration tools:

```ts
const nestedTeamTools = {
  team_create: false,
  team_spawn: false,
}
```

Expected behavior:

- Primary normal session with `experimental.agent_teams: true`: can use `team_create` and `team_spawn`.
- Subagent session created by `TaskTool`: cannot see `team_create` or `team_spawn`; direct execution fails.
- Teammate session created by `TeamSpawnTool`: cannot see `team_create` or `team_spawn`; direct execution fails.
- Child session that is not a team member: cannot create a new team in the first pass, matching existing `teamLeadSystemPrompt` behavior that withholds team lead guidance from child sessions.

## Failure Modes

- Direct `team_spawn` from a teammate must fail with a clear authorization error and must not create a session or team member row.
- Direct `team_create` from a teammate must fail with a clear authorization error and must not create a team row.
- Direct `team_create` from a subagent must fail with a clear authorization error and must not create a team row.
- Direct `team_spawn` from a subagent must fail before resolving dependencies or creating child sessions.
- Denying `team_create` is required because otherwise a teammate or subagent can create a nested team and then call `team_spawn` as that nested team's lead.

## Implementation Slices

### PR 1: Hide Nested Team Tools From Subagents And Teammates

- Update `src/agent/subagent-permissions.ts` so derived subagent session permissions deny `team_create` and `team_spawn` by default.
- Update `src/tool/task.ts` so subagent prompt `tools` explicitly disables `team_create` and `team_spawn`, following the existing `todowrite`, `task`, and `experimental.primary_tools` pattern.
- Update `src/tool/team_spawn.ts` so teammate `ops.prompt(...)` always disables `team_create` and `team_spawn`, in addition to existing plan-mode edit tool disables.
- Add or update tests in `test/tool/task.test.ts` to assert subagent prompt tool overrides include `team_create: false` and `team_spawn: false`.
- Add or update tests in `test/tool/team_spawn.test.ts` to assert teammate prompt tool overrides include `team_create: false` and `team_spawn: false`.

Verification:

- `bun test --timeout 30000 test/tool/task.test.ts test/tool/team_spawn.test.ts`
- `bun typecheck`

### PR 2: Add Execution Guards Against Nested Team Orchestration

- Update `src/tool/team_create.ts` to reject calls when `ctx.sessionID` belongs to an active team member.
- Update `src/tool/team_create.ts` to reject calls when the current session has a `parentID`, preventing subagents and other child sessions from becoming nested team leads.
- Update `src/tool/team_spawn.ts` to reject calls when `ctx.sessionID` belongs to an active team member.
- Update `src/tool/team_spawn.ts` to reject calls when the current session has a `parentID` and is not the primary lead session.
- Ensure guards run before any session creation, team creation, member insertion, or prompt invocation.
- Add direct negative tests in `test/tool/team_spawn.test.ts` for teammate callers.
- Add direct negative tests for `team_create` in the nearest existing team tool test file, or create `test/tool/team_create.test.ts` if none exists.

Verification:

- `bun test --timeout 30000 test/tool/team_spawn.test.ts test/team/team.test.ts`
- `bun test --timeout 30000 test/tool/registry.test.ts test/tool/task.test.ts test/tool/team_spawn.test.ts test/tool/team_messages.test.ts test/team/team.test.ts test/session/prompt.test.ts`
- `bun typecheck`

## Future Work

- Add role-aware filtering in `ToolRegistry.tools(...)` if more tools become lead-only.
- Add an explicit team role enum to `Team.getContext(...)` if future authorization checks need more than inferred lead/member state.
- Consider a shared `assertPrimarySessionCanLeadTeam(...)` helper if `team_create` and `team_spawn` authorization logic grows beyond a few checks.

## Open Questions

- Should child sessions that are not subagents or teammates ever be allowed to create teams? Default recommendation: no for the first pass, because `teamLeadSystemPrompt` already treats child sessions as non-leads.
