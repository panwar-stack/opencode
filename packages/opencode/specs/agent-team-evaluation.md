# Agent Team Evaluation

## Goal

Harden agent-team observability by turning a completed team run into an evaluation DAG with deterministic health checks, root-cause attribution, and regression fixtures.

This spec adapts the AgentEval paper's useful parts to this repo: model team execution as a DAG, score typed nodes, distinguish local failures from propagated failures, and make regressions easy to catch in CI.

## Current State

- Team orchestration is persisted in `src/team/team.sql.ts`.
- Team service state changes live in `src/team/team.ts`.
- Team execution is driven mostly by tools, especially `src/tool/team_spawn.ts`.
- Mailbox delivery is injected in `src/session/prompt.ts`.
- Session step/tool events already exist in `src/v2/session-event.ts`.
- `team_report` already reports throughput, messaging, cost, and tokens, but it does not reconstruct an explicit graph or classify failures.

## Non-Negotiables

- Keep the first implementation deterministic. Do not require an LLM judge for the base feature.
- Reconstruct from persisted data and existing events; avoid parsing free-form message text except as a last resort.
- Preserve existing team APIs and SDK compatibility unless the PR explicitly includes SDK regeneration.
- Do not add a central team scheduler. Evaluation is post-run/read-side analysis.
- Run tests from `packages/opencode`, never from repo root.

## Data Model

Create a small evaluation model, likely under `src/team/eval.ts`.

Required output shape:

```ts
type TeamEvalReport = {
  team_id: string
  generated_at: number
  nodes: TeamEvalNode[]
  edges: TeamEvalEdge[]
  findings: TeamEvalFinding[]
  summary: {
    node_count: number
    edge_count: number
    root_cause_count: number
    propagated_failure_count: number
    structural_deviation_count: number
    longest_dependency_chain: number
  }
}
```

Node types:

- `team`: team lifecycle.
- `member`: teammate lifecycle.
- `task`: shared task lifecycle.
- `message`: mailbox message.
- `session_step`: V2 model step event when available.
- `tool_call`: V2 tool call event when available.
- `result`: teammate final result.

Edge types:

- `lead_to_member`: lead spawned teammate.
- `depends_on`: teammate dependency or task dependency.
- `message_to`: mailbox sender to recipient.
- `produces`: member to result.
- `contains`: team to member/task/message.
- `session_event`: member or lead session to step/tool event.
- `propagates_to`: failed upstream node caused or likely caused downstream failure.

Finding severities:

- `info`
- `warning`
- `error`

Finding categories:

- `planning.goal_or_decomposition`
- `planning.missing_or_wrong_dependency`
- `execution.unknown_agent`
- `execution.cancelled_member`
- `execution.empty_result`
- `execution.stuck_or_blocked`
- `messaging.pending_delivery`
- `messaging.missing_progress`
- `integration.context_loss`
- `integration.premature_shutdown`
- `structure.unexpected_or_missing_edge`

## Deterministic Checks

Implement these first:

- Member with `status = "cancelled"` creates `execution.cancelled_member`.
- Member with `status = "blocked"` and all dependencies completed creates `execution.stuck_or_blocked`.
- Member with `status = "completed"` and empty/null `result` creates `execution.empty_result`.
- Member dependency references a missing session creates `planning.missing_or_wrong_dependency`.
- Task dependency references a missing task creates `planning.missing_or_wrong_dependency`.
- Team closed with active/starting/blocked members creates `integration.premature_shutdown`.
- Message recipient row still `pending` when team is closed creates `messaging.pending_delivery`.
- No `depends_on` edges with more than one member is not a failure, but record `structural_deviation_count` if expected edges are supplied by a fixture.

Root-cause attribution:

- A failed node with no failed parent is a root cause.
- A failed node with failed parents is propagated from the failed parent with highest severity.
- If severity ties, use the earliest `time_created`.
- Add `propagates_to` edges from selected root or parent to downstream failures.

## API And Tool Surface

Add one read-side API endpoint:

- `GET /team/:teamID/eval`
- Response: `TeamEvalReport`
- Group: existing `team` HTTP group.

Extend `team_report`:

- Include evaluation summary counts.
- Include top root-cause findings.
- Keep the current throughput/cost sections.
- Put full node/edge detail in metadata, not the human-readable report body.

Optional but useful:

- Add `team_eval` tool only if another agent needs model-accessible graph details. Prefer extending `team_report` first.

## Implementation Slices

### PR 1: DAG Builder And Deterministic Tests

- Add `src/team/eval.ts`.
- Load team, members, tasks, messages, and message recipients.
- Build nodes and edges.
- Implement deterministic findings and root-cause propagation.
- Add focused tests in `test/team/team-eval.test.ts`.

Verification:

- `bun test --timeout 30000 test/team/team-eval.test.ts`
- `bun typecheck`

### PR 2: HTTP Endpoint

- Add schemas to `src/server/routes/instance/httpapi/groups/team.ts`.
- Add handler in `src/server/routes/instance/httpapi/handlers/team.ts`.
- Regenerate SDK after OpenAPI changes.

Verification:

- `bun test --timeout 30000 test/server/httpapi-team.test.ts` or add a focused team API test.
- `bun dev generate > /tmp/opencode-openapi.json`
- From repo root: `./packages/sdk/js/script/build.ts`
- From `packages/opencode`: `bun typecheck`

### PR 3: Report Integration

- Extend `src/tool/team_report.ts` to call the eval builder.
- Add summary counts and top root-cause findings to the report body.
- Add full eval report to `metadata.eval`.
- Update/extend tool tests.

Verification:

- `bun test --timeout 30000 test/tool/team_report.test.ts` if present, otherwise add one.
- `bun typecheck`

### PR 4: Regression Fixtures

- Add small fixture-driven tests that create representative teams:
  - happy path: lead plus two completed independent teammates.
  - dependency path: one member depends on another and receives result context.
  - blocked bug: dependent stays blocked after dependency completed.
  - messaging bug: pending recipient remains after team close.
  - cancelled member propagates to dependent.
- Keep fixtures deterministic; use service calls directly instead of LLM calls.

Verification:

- `bun test --timeout 30000 test/team/team-eval.test.ts test/tool/team_spawn.test.ts`
- `bun typecheck`

## Future LLM Judge Layer

Do not include this in the first PR unless explicitly requested.

When deterministic eval is stable, add optional judge scoring behind config/env:

- `Plan`: completeness, feasibility.
- `TeamSpawn`: agent fit, dependency correctness, prompt clarity.
- `Mailbox`: recipient correctness, relevance, timeliness.
- `Exec`: task completion, tool failure handling.
- `Synth`: faithfulness to teammate results, completeness.

Store judge output separately from deterministic findings so CI can run without API keys.

## Open Questions

- Should evaluation reports be persisted, or always computed on read? Default to computed on read.
- Should expected DAG schemas live in tests only, or support user-provided expected DAGs later? Default to tests only.
- Should TUI show eval details? Leave out of first pass; the HTTP endpoint and `team_report` are enough.
