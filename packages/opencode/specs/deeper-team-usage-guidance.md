# Deeper Team Usage Guidance And Telemetry

## Goal

Make team sessions measurably better than "spawn a few agents and summarize." The first implementation should add model-facing guidance, deterministic usage metrics, shallow-usage detection, and report/docs updates without changing team scheduling semantics.

Implementation should preserve the current team model: leads coordinate with tools, teammates run as child sessions, shared tasks are tracking-only, and reports evaluate coordination quality after the fact.

## Current State

- `packages/opencode/src/session/prompt.ts` already tells leads to create teams early, delegate, parallelize independent work, and continuously decompose work, but it does not require a checklist for shared tasks, owners, dependencies, plan mode, broadcasts, or final reporting.
- `packages/opencode/src/tool/team_spawn.ts` supports `depends_on`, `wait_for`, and `plan_mode`.
- `packages/opencode/src/team/team.sql.ts` persists teams, members, member `dependency_ids`, member `plan_mode`, shared tasks, task `dependency_ids`, and mailbox data.
- `packages/opencode/src/team/eval.ts` builds deterministic team evaluation summaries and findings.
- `packages/opencode/src/tool/team_report.ts` reports throughput, tasks, messaging, cost, evaluation, and comparison metadata.
- `packages/opencode/src/team/README.md` documents no central scheduler, dependency blocking, mailbox behavior, plan mode, shared tasks, `GET /team/:teamID/eval`, and `team_report`.
- `packages/web/src/content/docs/agent-teams.mdx` documents agent teams, but its public tool table omits `team_report` and needs stronger recommended workflow guidance.
- `packages/web/src/content/docs/server.mdx` omits `GET /team/:teamID/eval` from the public Team API table.
- Existing related specs: `packages/opencode/specs/agent-team-evaluation.md`, `packages/opencode/specs/structured-team-handoffs.md`, and `packages/opencode/specs/prevent-nested-team-spawning.md`.

## Non-Negotiables

- Do not add a central scheduler or make shared tasks start teammates automatically.
- Do not block team creation or spawning when guidance is not followed; first pass must surface findings and report metrics.
- Metrics must be deterministic from persisted tool/team state, not LLM judgment.
- Historical teams must remain readable after migration.
- Do not implement the larger structured handoff or persisted team plan workflow in this pass.
- If HTTP schema changes, regenerate OpenAPI/SDK artifacts.

## Lead Checklist

Add this checklist to model-facing guidance in `packages/opencode/src/session/prompt.ts` and relevant tool descriptions:

- Create shared tasks for multi-step work.
- Assign owners before implementation starts.
- Use dependencies when one task needs another result.
- Use plan mode for risky or broad edits.
- Broadcast scope changes or key discoveries.
- Run a final team report.

## Usage Metrics

Add a deterministic usage summary computed from team state:

```ts
type TeamUsageMetrics = {
  work_item_count: number
  task_count: number
  member_count: number
  dependency_count: number
  plan_mode_member_count: number
  plan_approval_count: number
  broadcast_count: number
  final_report_generated: boolean
  shallow_usage: boolean
}
```

Definitions:

- `work_item_count` defaults to `max(task_count, member_count)`.
- `dependency_count` counts non-empty `TeamMemberTable.dependency_ids` plus non-empty `TeamTaskTable.dependency_ids`.
- `plan_mode_member_count` counts members spawned with `plan_mode: true`.
- `plan_approval_count` should be persisted from `team_plan_decide` approvals.
- `broadcast_count` should be persisted from `team_broadcast`.
- `final_report_generated` should be persisted when `team_report` runs after no members are active, starting, or blocked.
- `shallow_usage` is true when a team was created, teammates were spawned, no shared tasks were created, no dependencies were modeled, no plan approvals occurred, and no final report was generated.

Add rollup percentages for team sessions:

```ts
type TeamUsageRollup = {
  team_session_count: number
  task_list_usage_percent: number
  dependency_modeling_percent: number
  plan_mode_usage_percent: number
  final_report_percent: number
  shallow_usage_percent: number
}
```

Success criteria:

- Every team run with `work_item_count >= 3` should have at least one shared task.
- At least one dependency should be modeled when sequencing matters.
- Plan mode should be used for implementation teammates touching risky areas.
- `team_report` should be generated for non-trivial team sessions.

## Data Model

Add a small usage event table in `packages/opencode/src/team/team.sql.ts` rather than overloading mailbox content:

```ts
team_usage_event {
  id: text primary key
  team_id: text not null
  session_id: text
  member_id: text
  type: text not null
  metadata: text not null default "{}"
  time_created: integer not null
}
```

Initial event types:

- `plan_approved`
- `plan_rejected`
- `broadcast_sent`
- `report_generated`

Use existing persisted tables for task creation, task dependencies, member dependencies, and `plan_mode`.

## API And Report Surface

Extend `TeamEvalReport` in `packages/opencode/src/team/eval.ts`:

```ts
type TeamEvalReport = {
  summary: {
    usage: TeamUsageMetrics
  }
  findings: TeamEvalFinding[]
}
```

Add finding behavior:

- Emit `shallow_usage` when the exact anti-pattern is detected.
- Emit `missing_task_list` when `work_item_count >= 3` and `task_count === 0`.
- Emit `missing_final_report` for non-trivial completed teams without a final report event.

Extend `team_report` in `packages/opencode/src/tool/team_report.ts`:

- Add a `Team usage` section with current-team booleans and counts.
- Add rollup percentages in metadata.
- Record `report_generated` when report generation qualifies as final.

Update HTTP schemas in `packages/opencode/src/server/routes/instance/httpapi/groups/team.ts` if `GET /team/:teamID/eval` returns the new usage fields.

## Implementation Slices

### PR 1: Add Lead Checklist Guidance

- Update `packages/opencode/src/session/prompt.ts` with the lead checklist.
- Update `packages/opencode/src/tool/team_create.txt`, `team_spawn.txt`, `team_broadcast.txt`, `team_task_create.txt`, and `team_report.txt` so tool descriptions reinforce the same workflow.
- Keep guidance advisory; do not add hard enforcement.

Verification:

- `cd packages/opencode && bun test test/session/prompt.test.ts test/tool/team_spawn.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only teammate or sub-agent to compare the prompt/tool description diff against the checklist and confirm it does not imply shared tasks spawn teammates or that dependencies are mandatory for every team.

### PR 2: Persist Usage Events

- Add `team_usage_event` storage in `packages/opencode/src/team/team.sql.ts`.
- Add migration with `cd packages/opencode && bun run db generate --name team_usage_events`.
- Add `Team.Service` methods in `packages/opencode/src/team/team.ts` for creating and listing usage events.
- Record events from `team_plan_decide`, `team_broadcast`, and `team_report`.

Verification:

- `cd packages/opencode && bun test test/team/team.test.ts test/tool/team_messages.test.ts test/tool/team_report.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only teammate or sub-agent to verify the migration is additive, historical teams remain readable, and event writes are limited to the intended tools.

### PR 3: Add Metrics And Shallow Usage Detection

- Extend `packages/opencode/src/team/eval.ts` with `TeamUsageMetrics`.
- Add findings for `shallow_usage`, `missing_task_list`, and `missing_final_report`.
- Extend `packages/opencode/src/tool/team_report.ts` output and metadata with current-team usage metrics and rollup percentages.
- Update `packages/opencode/src/server/routes/instance/httpapi/groups/team.ts` schemas if eval output changes.

Verification:

- `cd packages/opencode && bun test test/team/team-eval.test.ts test/tool/team_report.test.ts test/server/httpapi-team.test.ts`
- `cd packages/opencode && bun dev generate > /tmp/opencode-openapi.json`
- `./packages/sdk/js/script/build.ts`
- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only teammate or sub-agent to review metric fixtures against the definitions, especially denominator choices for percentages and the exact shallow-usage predicate.

### PR 4: Update Docs

- Update `packages/opencode/src/team/README.md` with the checklist, metric definitions, and shallow usage anti-pattern.
- Update `packages/web/src/content/docs/agent-teams.mdx` with recommended team workflow and `team_report` in the tool table.
- Update `packages/web/src/content/docs/server.mdx` to include `GET /team/:teamID/eval`.

Verification:

- `cd packages/web && bun typecheck`
- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only teammate or sub-agent to check docs against implemented behavior and confirm no future structured-handoff features are described as shipped.

## Future Work

- Add a persisted `team_plan_create` workflow from `structured-team-handoffs.md`.
- Add structured teammate handoff summaries.
- Add TUI indicators for shallow usage and missing final report.
- Add configurable thresholds for what counts as "non-trivial."

## Open Questions

- Should rollup percentages include all teams or only teams with at least one spawned teammate? Default: only teams with at least one teammate.
- Should `final_report_generated` require all members to be terminal? Default: yes, otherwise it is an interim report.
- Should missing plan mode be a finding by itself? Default: no; report the count, but only flag shallow usage unless risky-area detection becomes deterministic.
