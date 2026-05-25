# Structured Team Handoffs

## Goal

Make agent teams behave more like managed teams instead of a collection of helper spawns. For non-trivial work, the lead should have a concrete team plan before spawning, teammates should have explicit ownership and dependency boundaries, downstream teammates should receive structured upstream handoffs, plan-mode approvals should be durable state, and `team_report` should produce a normalized effectiveness score after the run.

The first pass should stay inside the existing team architecture: the lead remains a normal session, teammates remain child sessions, `team_spawn` remains the execution path, and shared tasks remain tracking data. Add structure around orchestration decisions and handoff data without introducing a central scheduler.

## Current State

- `src/team/team.sql.ts` persists `team`, `team_member`, `team_task`, `team_message`, and `team_message_recipient` rows. `team_member` already has `plan_mode`, `work_mode`, `dependency_ids`, and `result`, while `team_task` has `assignee`, `dependency_ids`, and `metadata`.
- `src/team/team.ts` owns team lifecycle, mailbox delivery, shared task state, and member status updates. Task dependency checks currently gate `team_task_claim`; task updates do not wake downstream teammates or create handoff events.
- `src/tool/team_spawn.ts` supports `depends_on` and `wait_for` by teammate name or session ID. Blocked teammates start when dependency members complete, and completed dependency results are injected as plain text under `Dependency results:`.
- `src/tool/team_task_create.ts`, `src/tool/team_task_claim.ts`, and `src/tool/team_task_update.ts` implement shared task tracking. Creating a task does not spawn or wake a teammate, and task ownership is an arbitrary assignee string.
- `src/tool/team_plan_submit.ts` sends the submitted plan to the lead as a mailbox message. `src/tool/team_plan_decide.ts` approves by removing mutating-tool deny rules or rejects by sending feedback. There is no persisted plan version, approval state, approver, timestamp, or audit trail.
- `src/tool/team_send_message.ts`, `src/tool/team_broadcast.ts`, and `src/tool/team_get_messages.ts` provide mailbox coordination. Message purpose is free-form, so reports cannot distinguish handoffs, blockers, progress updates, and approval requests without parsing prose.
- `src/session/prompt.ts` encourages early `team_create`, aggressive delegation, parallel spawns, and dependency use. This is prompt guidance only; no tool captures a proposed team plan before spawning.
- `src/team/eval.ts` builds a deterministic team evaluation graph with findings for missing dependencies, cancelled members, empty results, stuck blocked members, pending delivery, premature shutdown, and structural deviations.
- `src/tool/team_report.ts` reports throughput, tasks, messaging, cost, latency, evaluation findings, and baseline comparisons. It does not output a normalized effectiveness score or category rubric for planning, spawning, handoffs, execution, and integration.
- Relevant tests already exist in `test/tool/team_spawn.test.ts`, `test/team/team.test.ts`, `test/tool/team_messages.test.ts`, `test/team/team-eval.test.ts`, `test/tool/team_report.test.ts`, and `test/server/httpapi-team.test.ts`.
- `src/team/README.md` documents the current mental model: no central scheduler, teammates are child sessions plus `team_member` rows, mailbox messages wake sessions, plan mode is permission rules plus mailbox coordination, and shared tasks are separate from teammate dependencies.

## Motivating Gaps

- Team usage is often shallow: leads spawn teammates, but shared task tracking, dependency modeling, plan mode, broadcast, and reporting are rarely used together.
- Dependencies are easy to model incorrectly. `../agent-team-sessions/session-ses_20ea.md:97-164` creates shared tasks, but `../agent-team-sessions/session-ses_20ea.md:290-303` later hits `Task not found`, causing the lead to stop relying on shared task state.
- Producer-consumer work is easy to over-parallelize. `../agent-team-sessions/session-ses_20ea.md:575-600` identifies dependencies, but `../agent-team-sessions/session-ses_20ea.md:617-662` spawns implementation teammates concurrently despite core-interface dependencies.
- Integration mismatch appears late when upstream results are not structured. `../agent-team-sessions/session-ses_20ea.md:990-1017` shows mismatches discovered after concurrent work.
- The desired behavior is to auto-generate a team plan from the user request for non-trivial tasks: roles, dependencies, read/write boundaries, verification owner, and success criteria should exist before spawning.

## Non-Negotiables

- Do not add a central team scheduler. The model still chooses tools, and `team_spawn` remains responsible for teammate execution and dependency blocking.
- Keep first-pass scoring deterministic. Do not require an LLM judge for CI or base reporting.
- Preserve existing `team_create`, `team_spawn`, shared task, mailbox, plan-mode, and `team_report` behavior for callers that do not use the new structure.
- Do not make shared tasks automatically spawn teammates in the first pass. Tasks can reference planned teammates and member sessions, but execution still happens through `team_spawn`.
- Do not parse free-form mailbox text for required behavior. Store structured plan, approval, and handoff fields when behavior depends on them.
- Keep dependency references resolvable by stable IDs once persisted. Names may be accepted at tool boundaries, but stored graph edges must point to plan node IDs, task IDs, or member session IDs.
- Run tests from `packages/opencode`, never from repo root.

## Team Plan Model

Add a persisted team plan that records the intended roles, task ownership, dependencies, read/write boundaries, verification ownership, and success criteria before spawning.

Recommended storage:

- `team_plan`: one active plan per team, with historical versions preserved.
- `team_plan_node`: one planned role/work item per teammate or lead-owned integration step.
- `team_plan_edge`: dependency edges between planned nodes.

Recommended shape:

```ts
type TeamPlan = {
  id: string
  team_id: string
  version: number
  status: "draft" | "active" | "superseded"
  created_by_session_id: string
  created_at: number
  goal: string
  success_criteria: string[]
}

type TeamPlanNode = {
  id: string
  team_plan_id: string
  name: string
  kind: "explore" | "implement" | "review" | "verify" | "integrate"
  agent_type?: string
  owner_session_id?: string
  task_id?: string
  member_session_id?: string
  role_prompt: string
  read_scope: string[]
  write_scope: string[]
  expected_handoff: string[]
  verification_owner: boolean
  plan_mode: boolean
  status: "planned" | "spawned" | "blocked" | "active" | "completed" | "cancelled"
}

type TeamPlanEdge = {
  id: string
  team_plan_id: string
  from_node_id: string
  to_node_id: string
  kind: "blocks" | "informs" | "reviews" | "verifies"
}
```

Behavior:

- The lead can create a plan explicitly before spawning teammates.
- The plan records intended parallelism. Nodes with no unsatisfied `blocks` edges can be spawned in the same assistant step.
- The plan records producer-consumer dependencies. Downstream node prompts should include upstream structured handoffs, not only final free-form result text.
- Plan nodes may reference shared tasks for tracking, but shared tasks remain optional and do not drive spawning.
- A spawned teammate updates the matching `team_plan_node.member_session_id` and status. If the lead spawns without a plan node, record a structural evaluation finding instead of failing the spawn.
- Superseding a plan creates a new version and marks the old active version `superseded`; do not mutate historical plan topology in place after spawns begin.

## Auto-Generated Plan And Spawning

Add a model-facing tool for creating a proposed plan from the user request before `team_spawn` calls. The first pass should let the lead model generate the plan as structured tool arguments instead of adding a second internal LLM call. The generated plan becomes the source of truth for suggested roles, dependency edges, read/write boundaries, verification ownership, and success criteria.

Recommended tool:

```ts
team_plan_create({
  goal: string,
  success_criteria: string[],
  nodes: Array<{
    name: string
    kind: "explore" | "implement" | "review" | "verify" | "integrate"
    agent_type?: string
    role_prompt: string
    read_scope?: string[]
    write_scope?: string[]
    expected_handoff?: string[]
    verification_owner?: boolean
    plan_mode?: boolean
  }>,
  edges?: Array<{
    from: string
    to: string
    kind: "blocks" | "informs" | "reviews" | "verifies"
  }>,
})
```

Update lead guidance in `src/session/prompt.ts`:

- For non-trivial tasks, create a plan before spawning unless the user asks to work without teammates.
- Include roles, dependencies, read/write boundaries, verification owner, and success criteria.
- Spawn independent planned nodes in parallel.
- Use `depends_on` / `wait_for` for planned `blocks` edges.
- Use plan mode for implementation nodes that should receive lead approval before mutation.

Update `team_spawn`:

- Accept an optional `plan_node_id`.
- If `plan_node_id` is provided, derive missing `depends_on`, `plan_mode`, and role metadata from the active plan node when possible.
- If both explicit `depends_on` and plan edges are provided, validate they are consistent. A missing explicit dependency that exists in the plan can be added automatically; an explicit dependency that contradicts the plan should fail with a clear error.
- Mark the plan node `spawned`, `blocked`, or `active` along with the `team_member` status.
- Keep existing name/session dependency resolution for unplanned or backward-compatible spawns.

Failure modes:

- Duplicate plan node names in a plan must fail before persistence.
- Plan edges that reference missing nodes must fail before persistence.
- Cyclic `blocks` edges must fail before persistence.
- A `plan_node_id` that belongs to another team must fail before spawning.
- A plan node that is already linked to a member must fail if spawned again unless the previous member is cancelled and the lead creates a superseding plan.

## Structured Handoff Model

Add first-class handoff records so downstream teammates and reports can consume producer output without parsing free-form result text.

Recommended storage:

- `team_handoff`: one structured handoff from a source session to one or more target plan nodes, tasks, members, or the lead.
- Store handoff recipients in a separate table if multiple recipient types make a single JSON field hard to query.

Recommended shape:

```ts
type TeamHandoff = {
  id: string
  team_id: string
  from_session_id: string
  plan_node_id?: string
  task_id?: string
  kind: "progress" | "handoff" | "blocker" | "review" | "verification"
  summary: string
  artifacts: Array<{ path: string; description?: string }>
  changed_files: string[]
  decisions: string[]
  blockers: string[]
  follow_up_tasks: string[]
  confidence: "low" | "medium" | "high"
  created_at: number
}
```

Recommended tool:

```ts
team_handoff_submit({
  kind: "progress" | "handoff" | "blocker" | "review" | "verification"
  summary: string
  recipients?: string[]
  artifacts?: Array<{ path: string; description?: string }>
  changed_files?: string[]
  decisions?: string[]
  blockers?: string[]
  follow_up_tasks?: string[]
  confidence?: "low" | "medium" | "high"
})
```

Behavior:

- Teammate prompts should request a structured handoff before completion when the assignment has downstream dependencies or expected handoff fields.
- `team_spawn` should inject upstream handoffs into dependent prompts before the free-form dependency result text.
- `team_handoff_submit` should also create a mailbox message for intended recipients and wake idle recipients, following `team_send_message` semantics.
- Handoffs should be included in the evaluation DAG as nodes with edges from source member to target member, task, or plan node.
- Free-form teammate final `result` remains supported and is still shown to the lead.
- If a teammate completes without a required handoff, the run should continue, but `team_report` should include a deterministic finding.

## Approval State Model

Make plan mode auditable without changing the core permission mechanism.

Recommended storage:

- `team_plan_approval`: one row per submitted plan-mode approval request version.

Recommended shape:

```ts
type TeamPlanApproval = {
  id: string
  team_id: string
  member_session_id: string
  plan_node_id?: string
  version: number
  status: "pending" | "approved" | "rejected" | "superseded"
  plan: string
  feedback?: string
  submitted_at: number
  decided_at?: number
  decided_by_session_id?: string
}
```

Update existing tools:

- `team_plan_submit` creates a pending approval row and sends the lead a mailbox message with the approval ID.
- `team_plan_decide` accepts either the current member name flow or an `approval_id`. When an approval is accepted, mark it `approved`, store the approver and timestamp, remove mutating-tool deny rules, message the teammate, and wake the teammate.
- Rejection marks the approval `rejected`, stores feedback, keeps plan mode in place, messages the teammate, and wakes the teammate.
- A new submission from the same member supersedes any previous pending approval for that member.

Failure modes:

- Approving an approval for another active team must fail.
- Approving a non-pending approval must fail with the current status.
- Rejecting without feedback should fail unless the tool schema explicitly permits empty feedback.
- Removing permission deny rules must remain coupled to persisted `approved` state; do not approve in storage if permission update fails.

## Effectiveness Scoring

Extend `src/team/eval.ts` and `src/tool/team_report.ts` with a deterministic score that reflects whether the team used the managed-team features effectively.

Recommended score shape:

```ts
type TeamEffectivenessScore = {
  total: number
  grade: "excellent" | "good" | "fair" | "poor"
  categories: {
    planning: TeamScoreCategory
    dependency_modeling: TeamScoreCategory
    handoffs: TeamScoreCategory
    approval_control: TeamScoreCategory
    execution: TeamScoreCategory
    integration: TeamScoreCategory
  }
}

type TeamScoreCategory = {
  score: number
  max: number
  findings: string[]
}
```

Initial deterministic rubric:

- Planning, 20 points: active plan exists for non-trivial team, every spawned member is linked to a plan node, success criteria exist, and one verification or integration owner exists.
- Dependency modeling, 20 points: planned `blocks` edges match spawned `depends_on`, no missing dependencies, no stuck blocked members, and no producer-consumer node was spawned early.
- Handoffs, 20 points: required upstream nodes submitted handoffs, dependent prompts received structured handoffs, blockers were represented as blocker handoffs, and handoff recipients were delivered.
- Approval control, 10 points: plan-mode members have persisted approval rows, no mutating tools run before approval, rejections preserve plan mode, and approval decisions are auditable.
- Execution, 15 points: members complete with non-empty results, task dependencies are satisfied before claim, no unexpected cancellations, and no pending mailbox delivery remains on close.
- Integration, 15 points: lead integrates completed teammate results after dependencies resolve, final report references success criteria, no premature shutdown, and verification owner completed.

Behavior:

- Include `score` in `TeamEvalReport.summary` or a new `TeamEvalReport.score` field.
- Include score category summary in `team_report` body and full score details in `metadata.eval.score`.
- Expose score through `GET /team/:teamID/eval` alongside existing graph and findings.
- Treat absent first-pass features as zero for their category only when the run is non-trivial. A single-teammate team should not be penalized for lacking dependency edges.
- Keep category weights constant in code and tests; do not make user-configurable weights in the first pass.

## Failure Modes

- A plan says implementation depends on exploration, but `team_spawn` starts implementation without the exploration member dependency: fail the spawn when using `plan_node_id`; otherwise report `planning.missing_or_wrong_dependency` and subtract dependency-modeling points.
- A downstream member starts after an upstream member completed with no structured handoff: allow execution, inject the legacy result text, and report a handoff finding.
- A teammate submits a blocker as a free-form mailbox message instead of `team_handoff_submit`: keep mailbox delivery working, but do not count it as structured blocker handling.
- A lead approves plan mode by member name while multiple pending approvals exist for that member: fail and require `approval_id`.
- A team closes with active planned nodes or pending approvals: report premature shutdown and subtract planning, approval-control, and integration points.
- A plan is created but never used for spawning: report a structural finding, but do not block final reporting.

## Implementation Slices

### PR 1: Persist Team Plans And Planned Dependencies

- Add `team_plan`, `team_plan_node`, and `team_plan_edge` tables in `src/team/team.sql.ts` using snake_case columns.
- Add service methods in `src/team/team.ts` for creating active plan versions, listing active plan nodes, linking a plan node to a spawned member, and marking plan node status.
- Add `team_plan_create` under `src/tool/` with validation for duplicate names, missing edge endpoints, and cyclic `blocks` edges.
- Update `src/session/prompt.ts` lead guidance to call `team_plan_create` before spawning for non-trivial tasks.
- Add focused service/tool tests for plan creation, validation, versioning, and active-plan lookup.
- Generate a migration with `bun run db generate --name structured-team-plan`.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/team/team.test.ts`
- `cd packages/opencode && bun test --timeout 30000 test/tool/team_plan_create.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Confirm plans are persisted as orchestration intent only, shared tasks remain tracking-only, and no scheduler loop was added.

### PR 2: Bind `team_spawn` To Plan Nodes

- Add optional `plan_node_id` to `src/tool/team_spawn.ts`.
- Resolve planned `blocks` edges into member `depends_on` when upstream plan nodes already have linked member sessions.
- Reject inconsistent explicit dependencies when `plan_node_id` is provided.
- Update plan node status as teammates move through `spawned`, `blocked`, `active`, `completed`, and `cancelled` states.
- Include plan node context, read/write boundaries, success criteria, and expected handoff fields in teammate prompts.
- Extend `test/tool/team_spawn.test.ts` for planned dependency blocking, inconsistent dependency rejection, plan-node status updates, and legacy unplanned spawn behavior.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/tool/team_spawn.test.ts test/team/team.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Confirm planned dependencies use the existing blocked-member path and that independent planned nodes can still be spawned in parallel by sibling tool calls.

### PR 3: Add Structured Handoffs

- Add `team_handoff` storage and service methods for creating and listing handoffs.
- Add `team_handoff_submit` under `src/tool/`.
- Make `team_handoff_submit` create mailbox notifications and wake recipients using the same recipient resolution behavior as `team_send_message` where possible.
- Update `team_spawn` dependency prompt construction to inject upstream structured handoffs before legacy dependency result text.
- Extend teammate prompt guidance so downstream dependencies and expected handoff fields cause teammates to submit structured handoffs before completion.
- Add handoff nodes and edges to `src/team/eval.ts`.
- Add tests for handoff creation, recipient delivery, dependency prompt injection, and missing required handoff findings.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/tool/team_handoff_submit.test.ts test/tool/team_spawn.test.ts`
- `cd packages/opencode && bun test --timeout 30000 test/team/team-eval.test.ts test/tool/team_messages.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Confirm required behavior reads structured handoff rows, not free-form mailbox text, and that legacy teammate results still work.

### PR 4: Persist Plan Approval State

- Add `team_plan_approval` storage and service methods for submitting, deciding, superseding, and listing approval requests.
- Update `team_plan_submit` to create pending approval rows and include approval IDs in lead mailbox messages.
- Update `team_plan_decide` to support `approval_id`, preserve the existing member-name path when unambiguous, and store approval or rejection decisions.
- Ensure permission-deny removal and persisted approval state update happen as one effectful operation from the caller's perspective.
- Add tests for pending approval creation, approval, rejection, superseding previous pending approval, ambiguous member-name decisions, and permission-state coupling.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/tool/team_plan_submit.test.ts test/tool/team_plan_decide.test.ts test/tool/team_spawn.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Confirm plan mode still uses existing session permission rules and mailbox wakeups; the new table is an audit/state layer, not a replacement execution mode.

### PR 5: Score Team Effectiveness

- Extend `src/team/eval.ts` with deterministic category scoring and score findings.
- Include plan, handoff, and approval nodes or metadata in the evaluation graph.
- Update `src/tool/team_report.ts` to show total score, grade, category scores, and the highest-impact findings.
- Update HTTP schemas in `src/server/routes/instance/httpapi/groups/team.ts` and handler tests for the expanded eval response.
- Add regression fixtures for shallow team usage, missing dependencies, unstructured handoffs, missing approval audit, and a high-scoring planned run.
- Regenerate SDK after OpenAPI changes.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/team/team-eval.test.ts test/tool/team_report.test.ts`
- `cd packages/opencode && bun test --timeout 30000 test/server/httpapi-team.test.ts`
- `cd packages/opencode && bun dev generate > /tmp/opencode-openapi.json`
- `./packages/sdk/js/script/build.ts`
- `cd packages/opencode && bun typecheck`

Review:

Confirm the score is deterministic, category weights are documented in tests, and single-teammate teams are not penalized for unnecessary dependency or handoff structure.

### PR 6: Documentation And Usage Guidance

- Update `src/team/README.md` with the team plan, structured handoff, approval state, and scoring model.
- Update `packages/web/src/content/docs/agent-teams.mdx` to explain when leads should create plans, how dependencies map to `team_spawn`, and how handoffs appear in reports.
- Update any tool descriptions so the lead model sees the preferred sequence: `team_create`, `team_plan_create`, parallel `team_spawn`, structured handoffs, approval decisions, verification, `team_report`.
- Add a small transcript-style example showing a producer-consumer team where implementation waits for exploration and review waits for implementation.

Verification:

- `cd packages/opencode && bun typecheck`

Review:

Confirm docs do not imply shared tasks automatically spawn teammates and do not instruct users to poll `team_get_messages` in loops.

## Future Work

- Add an optional LLM judge layer after deterministic scoring is stable. Keep judge output separate from deterministic findings so CI does not require API keys.
- Add TUI views for plan graph, handoff list, approval history, and score breakdown.
- Add a lead-side convenience tool that can spawn all currently unblocked planned nodes in one call. Leave this out of the first pass to avoid introducing scheduler semantics.
- Allow user-provided plan templates for recurring workflows such as exploration, implementation, review, and verification.
- Add richer artifact typing for diffs, test output, screenshots, logs, and benchmark results.

## Open Questions

- Should `team_plan_create` be required for all teams with more than one teammate? Default recommendation: no. Start with guidance plus scoring penalties for shallow non-trivial usage, then consider enforcement after observing real runs.
- Should handoffs be separate rows or typed mailbox messages? Default recommendation: separate rows with mailbox notifications, because reports and dependency prompts need queryable structure while mailbox remains delivery infrastructure.
- Should plan approvals be exposed in the HTTP API immediately? Default recommendation: include them only through team eval/report metadata in the first pass unless TUI work needs a dedicated endpoint.
