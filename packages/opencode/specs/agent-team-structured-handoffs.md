# Agent Team Structured Handoffs

## Goal

Make agent teams behave less like ad hoc helper fan-out and more like a managed team for three narrow areas: structured teammate handoffs, dependency-aware spawning, and safe edit modes for high-conflict files.

The first implementation should build on the existing team model instead of adding a scheduler. A teammate that completes work should leave a typed handoff. A teammate with dependencies should start only when its upstream work is complete and should receive those handoffs deterministically. A teammate assigned risky shared files should begin in a safe mode until the lead explicitly approves the edit scope.

## Current State

- `src/tool/team_spawn.ts` already accepts `depends_on`, `wait_for`, and `plan_mode`.
- `src/tool/team_spawn.ts` resolves dependency names or session IDs, stores dependency session IDs, marks blocked members, wakes blocked members after dependencies complete, and injects dependency results into their prompt.
- `src/tool/team_spawn.ts` currently stores teammate completion as a free-form text result and forwards it to the lead inside `<teammate_result>` tags.
- `src/tool/team_spawn.ts` tells dependencies to make final results clear handoffs, but this is prompt guidance rather than a typed contract.
- `src/team/team.ts` exposes member, task, message, and dependency operations. `Team.addMember` persists `dependencyIDs`, `planMode`, and `workMode`; `Team.createTask` accepts `dependencyIDs` and metadata.
- `src/team/team.sql.ts` persists team members, tasks, messages, dependency IDs, plan mode, work mode, and message recipients.
- `src/tool/team_plan_submit.ts` and `src/tool/team_plan_decide.ts` implement plan approval flow for teammates.
- `src/tool/team_plan_decide.ts` approves a plan by removing broad edit denial rules for `bash`, `write`, `edit`, and `apply_patch` where `pattern === "*"`.
- `src/tool/team_report.ts` and `src/team/eval.ts` already provide a place to surface team execution quality and deterministic findings.
- Existing relevant tests include `test/tool/team_spawn.test.ts`, `test/team/team.test.ts`, `test/tool/team_messages.test.ts`, `test/tool/team_report.test.ts`, and `test/team/team-eval.test.ts`.

External session evidence motivating this spec lives in the sibling evaluation corpus at `../agent-team-sessions` from the opencode repo root:

- `../agent-team-sessions/session-ses_20ea.md:91-95` shows the lead identifying a staged plan: research first, then architecture and implementation.
- `../agent-team-sessions/session-ses_20ea.md:97-164` creates shared tasks without dependency IDs despite that staged plan.
- `../agent-team-sessions/session-ses_20ea.md:290-303` shows `team_task_update` failing with `Task not found`, causing the lead to stop relying on shared task state.
- `../agent-team-sessions/session-ses_20ea.md:575-600` identifies real producer-consumer dependencies, then chooses concurrent spawning as a workaround.
- `../agent-team-sessions/session-ses_20ea.md:617-662` spawns `impl-core`, `impl-tools`, and `impl-entry` concurrently even though `impl-tools` and `impl-entry` depend on core interfaces.
- `../agent-team-sessions/session-ses_20ea.md:990-1017` shows an integration mismatch discovered after concurrent work.
- `../agent-team-sessions/session-ses_20ea.md:1230-1255` shows a teammate editing `src/index.ts` while importing tool files that were not created yet, a high-conflict integration boundary.
- `../agent-team-sessions/session-ses_1aeb.md:14911-14955` shows useful plan-mode behavior before implementation, while `../agent-team-sessions/session-ses_1aeb.md:15378-15390` shows a potential implementation-subagent escape hatch after approval became unclear.
- `../agent-team-sessions/session-ses_1b2e.md:16521-16613` treats `packages/opencode/src/server/routes/instance/httpapi/public.ts` as a high-risk shared file and scopes edits into smaller reviewed slices with generated-output checks.

## Non-Negotiables

- Keep scope limited to structured handoffs, dependency-aware spawning, and safe edit modes for high-conflict files.
- Do not add a central scheduler in the first pass.
- Do not replace existing team tools such as `team_send_message`, `team_get_messages`, `team_task_*`, `team_plan_submit`, or `team_plan_decide`.
- Do not rely on parsing free-form teammate prose as the only source of dependency or handoff state.
- Preserve `depends_on` and `wait_for` as aliases accepted by `team_spawn`.
- Missing dependency names or session IDs must fail before child sessions start.
- Keep lead approval explicit before escalating a high-conflict teammate from safe mode to edit mode.
- Do not let safe-mode approval remove unrelated deny rules or broaden file access beyond the approved scope.
- Keep behavior deterministic and testable without LLM calls.
- Run verification from `packages/opencode`, not from repo root.

## Handoff Model

Add a typed teammate handoff shape near the team domain code, likely `src/team/team.ts` or a small `src/team/handoff.ts` helper if reuse grows.

Required shape:

```ts
type TeamHandoff = {
  summary: string
  completed: string[]
  changed_files: string[]
  read_files: string[]
  blocked_on: string[]
  risks: string[]
  next_steps: string[]
  handoff_to?: string[]
}
```

Behavior:

- A completed teammate must still return normal final text for backward compatibility.
- The completion path in `src/tool/team_spawn.ts` must derive or attach a `TeamHandoff` from structured metadata when available.
- The first pass may accept a handoff object from tool metadata or a fenced JSON block in the final teammate text, but storage must keep the parsed object separate from the raw final text.
- If no valid structured handoff is present, create an incomplete handoff with `summary` from the final text prefix and an explicit risk such as `missing_structured_handoff`.
- Store the raw final result unchanged in the existing member `result` field.
- Add a nullable persisted handoff field for team members, because the current member storage has `result` but no generic member metadata column and dependency prompt injection needs structured handoffs after the upstream tool call completes.
- The new field should be a JSON column or encoded JSON text, matching the storage conventions already used in `src/team/team.sql.ts`.
- Completion notifications to the lead should show a concise handoff summary before the raw `<teammate_result>` body.
- `team_report` should surface missing handoffs, unresolved blockers, and handoff risks.

Failure modes:

- A teammate with empty final text and no handoff is completed with a `missing_structured_handoff` risk, not silently treated as a useful result.
- Invalid handoff JSON does not fail the whole teammate; it is stored as raw text and reported as an incomplete handoff.
- `handoff_to` entries that do not match teammate names or session IDs are reported as risks, not used as implicit dependencies.

## Dependency-Aware Spawning

Harden existing dependency behavior rather than replacing it.

Spawn-time behavior:

- `team_spawn` must validate every `depends_on` or `wait_for` entry against existing member names or session IDs before creating a child session.
- If any dependency is missing, return a clear failure and do not create a session or team member row.
- If all dependencies already completed successfully, start the teammate immediately and include structured dependency handoffs in the prompt.
- If any dependency is still active, starting, idle, or blocked, create the member in `blocked` state and do not start its prompt run.
- Notify active upstream dependencies that a downstream teammate is waiting on their work and should produce a structured handoff.

Unblock behavior:

- When an upstream teammate completes, re-check blocked teammates whose `dependency_ids` include that session ID.
- Start a blocked teammate only when all dependencies are completed and none are cancelled.
- Inject each dependency's structured handoff into the prompt, not only raw final text.
- Preserve raw dependency result text after the structured handoff for context.

Cancelled or failed dependency behavior:

- If a dependency is cancelled before the downstream teammate starts, keep the downstream teammate blocked and add a deterministic blocked reason.
- Do not auto-start a downstream teammate with partial or failed dependency context in the first pass.
- Notify the lead that the downstream teammate is blocked by a cancelled dependency and needs explicit lead action.
- `team_report` should classify this as a dependency blockage, not as an idle teammate.

Recommended dependency context format:

```md
Dependency handoffs:

- core-types (ses_...)
  Summary: Added TeamHandoff and dependency status types.
  Completed:
  - Added typed handoff schema.
  Changed files:
  - src/team/handoff.ts
  Risks:
  - Storage migration not implemented yet.
  Raw result:
  <original teammate result>
```

Relationship to team tasks:

- `team_task_create` already supports `dependency_ids`; this spec does not require automatic conversion from member dependencies to task dependencies.
- If a `team_spawn` is linked to a task in future work, task dependency validation must use the same fail-before-start rule.
- Do not treat local `todowrite` items as team dependency state.

## Safe Edit Modes For High-Conflict Files

Add an explicit safe edit mode for high-conflict file patterns. This should build on `plan_mode` and existing permission denial instead of adding a locking system.

High-conflict file selection:

- First pass must use explicit user or lead-provided file patterns, not git-history heuristics.
- Add optional `high_conflict_files` or `safe_edit_patterns` to `team_spawn` if this can be done without SDK/API churn. If API churn is required, use `plan_mode` plus role prompt conventions in PR 1 and add the parameter in a later API slice.
- File patterns should be workspace-relative globs, for example `src/index.ts` or `src/server/routes/instance/httpapi/public.ts`.

Safe mode behavior:

- A teammate assigned high-conflict files starts in `work_mode = "plan"` or a new `work_mode = "safe_edit"`.
- Safe mode denies `bash`, `write`, `edit`, and `apply_patch` until lead approval, matching current plan-mode behavior.
- The teammate may read/search files and submit a plan.
- The plan must list exact file patterns requested for edit escalation.
- The lead approval must specify the approved file patterns.

Approval behavior:

- Approval for high-conflict files should remove only the edit deny rules required for the approved scope.
- Approval must not remove unrelated parent-session deny rules, external directory restrictions, or nested-team tool restrictions.
- Approval applies to one teammate, not the whole team.
- Rejection keeps the teammate in safe mode and wakes it with feedback.
- If scoped permission rules are not expressive enough for per-file edit escalation, keep broad edit denial in place and require the lead session to perform the final mutation in the first pass.

Expected teammate pattern for single-file or high-conflict work:

- Research teammate: read-only findings and constraints.
- Implementation teammate: plan mode only, returns patch plan or exact snippet.
- Lead: applies final edit after approval, or explicitly approves scoped implementation.

Failure modes:

- A teammate in safe mode attempting to edit before approval must be blocked by tool permissions, not merely prompt text.
- A teammate must not bypass safe mode by launching a nested implementation subagent; nested team spawning is already forbidden, and high-conflict safe mode should also keep `task`/implementation-subagent escape hatches disabled if needed for enforcement.
- Approval for `src/index.ts` must not grant edit access to unrelated files.
- Team shutdown must mark safe-mode and blocked teammates as cancelled so they do not appear actionable.

## Tool And Prompt Surface

`team_spawn` parameters should evolve toward this shape:

```ts
type TeamSpawnInput = {
  name: string
  agent_type: string
  role_prompt: string
  depends_on?: string[]
  wait_for?: string[]
  plan_mode?: boolean
  high_conflict_files?: string[]
}
```

Prompt additions for teammates:

- Final answer should include a structured handoff with summary, completed work, files read/changed, blockers, risks, and next steps.
- If another teammate is waiting on this work, explicitly state the contract they can rely on.
- If in safe mode, submit a plan before edits and name the exact file patterns requiring approval.

Metadata additions for `team_spawn` output:

```ts
type TeamSpawnMetadata = {
  memberID?: string
  sessionID?: string
  dependencyIDs?: string[]
  handoff?: TeamHandoff
  blockedReason?: string
  safeEditPatterns?: string[]
}
```

Reporting additions:

- `team_report` should include counts for complete handoffs, incomplete handoffs, blocked dependency chains, cancelled dependency blockers, and safe-mode teammates awaiting approval.
- Full handoff objects should live in report metadata, not only the Markdown body.

## Implementation Slices

### PR 1: Structured Handoff Capture

- Add the `TeamHandoff` type and parser/normalizer near team domain code.
- Add a nullable persisted handoff field to team member storage in `src/team/team.sql.ts` and expose it through `src/team/team.ts` member reads/updates.
- Update `src/tool/team_spawn.ts` completion handling to attach a normalized handoff to tool metadata and lead completion notifications.
- Preserve raw teammate final text exactly as today.
- Add deterministic incomplete-handoff behavior for empty or invalid handoffs.
- Extend `src/tool/team_report.ts` or `src/team/eval.ts` to report missing or risky handoffs.
- Add focused tests for complete, missing, invalid, and empty handoffs.

Verification:

- `bun test --timeout 30000 test/tool/team_spawn.test.ts test/tool/team_report.test.ts test/team/team-eval.test.ts`
- `bun typecheck`

Review:

- Confirm the raw final result remains backward compatible.
- Confirm handoff parsing failures are visible but non-fatal.
- Confirm no LLM call is required for handoff validation tests.

### PR 2: Dependency Handoff Propagation And Failure Semantics

- Harden dependency validation in `src/tool/team_spawn.ts` so missing dependencies fail before session or member creation.
- Update blocked-member release logic to include structured dependency handoffs in prompt context.
- Add explicit behavior for cancelled dependencies: downstream members remain blocked and the lead is notified.
- Add deterministic blocked reasons to the same persisted handoff/status metadata used by PR 1, or to report metadata if blocked-reason storage is deliberately left out.
- Extend `team_report` to classify blocked dependency chains and cancelled upstream blockers.
- Add tests for already-completed dependencies, active dependencies, missing dependencies, and cancelled dependencies.

Verification:

- `bun test --timeout 30000 test/tool/team_spawn.test.ts test/team/team.test.ts test/tool/team_report.test.ts`
- `bun typecheck`

Review:

- Confirm no downstream teammate starts before all dependencies complete.
- Confirm dependency handoff prompt content is deterministic and testable.
- Confirm cancelled dependencies do not silently become raw prompt context.

### PR 3: Safe Edit Mode For High-Conflict Files

- Add explicit safe-edit state using existing `plan_mode`/`work_mode` fields, or introduce `work_mode = "safe_edit"` if that keeps behavior clearer.
- Add a minimal way to mark high-conflict file patterns for a teammate.
- Ensure safe-mode teammates cannot use `bash`, `write`, `edit`, or `apply_patch` before approval.
- Update `src/tool/team_plan_decide.ts` so approval preserves unrelated deny rules and does not broaden access beyond approved scope.
- If scoped edit permissions are not supported, keep edit tools denied and require the lead to apply the final patch in PR 3.
- Add tests for pre-approval edit denial, approval, rejection, and preservation of unrelated deny rules.

Verification:

- `bun test --timeout 30000 test/tool/team_spawn.test.ts test/tool/team_plan_decide.test.ts test/team/team.test.ts`
- `bun typecheck`

Review:

- Confirm safe mode is enforced by tool permissions, not prompt text.
- Confirm approval is per teammate and scoped to the approved file patterns or explicitly read-only if scoped permissions are unavailable.
- Confirm no implementation-subagent escape hatch can bypass safe mode.

### PR 4: Regression Fixtures And Reporting

- Add fixture-style tests for a multi-step team: core teammate completes with a handoff, dependent teammate starts with that handoff, high-conflict integrator stays in safe mode until approval.
- Add a regression for the `session-ses_20ea.md` failure shape: tasks/dependencies imply staging, but dependent implementation must not start concurrently without explicit dependency completion.
- Extend `team_report` Markdown with concise sections for handoff quality, dependency blockers, and safe-edit approvals.
- Keep full details in metadata for future UI/TUI use.

Verification:

- `bun test --timeout 30000 test/tool/team_spawn.test.ts test/tool/team_report.test.ts test/team/team-eval.test.ts test/tool/team_messages.test.ts`
- `bun typecheck`

Review:

- Confirm the report distinguishes useful parallelism from unsafe dependency violations.
- Confirm fixtures are deterministic service/tool tests and do not require live model calls.

## Future Work

- Auto-suggest dependency graphs from a lead's planned task list.
- Link `team_spawn` directly to shared team task IDs.
- Add TUI affordances for handoff completeness, blocked chains, and safe-edit approvals.
- Add heuristic high-conflict detection from open files, generated-output surfaces, or recent git history.
- Add outcome scoring for accepted handoffs and duplicated teammate work.

## Open Questions

- Should `high_conflict_files` be added to `team_spawn` immediately? Default recommendation: yes if no generated SDK/API impact is required; otherwise enforce safe mode through `plan_mode` first and add the parameter in a separate API-compatible slice.
- Should cancelled dependencies ever auto-start downstream teammates with failure context? Default recommendation: no for the first pass; require explicit lead action after cancellation.
