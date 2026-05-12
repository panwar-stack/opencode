# Opencode Autonomous Workflow Audit Report

Date: 2026-05-12

Brief audited: `opencode_autonomous_workflow_audit_brief.md`

## Summary

The repository contains a real autonomous workflow implementation across services, CLI, HTTP routes, TUI panels, config, events, and focused unit tests. The current implementation is best described as a partial orchestration layer, not yet the complete GitHub-reviewed autonomous workflow described in the brief.

The strongest implemented areas are durable workflow artifacts under `.opencode/workflows/<workflow_id>`, the expected state names, basic CLI/HTTP/TUI surfaces, GitHub PR state syncing, approval hash recording, amendment files, session visibility, and some scope checks.

The main missing areas are the actual autonomous planning loop, strict pre-edit scope enforcement, robust GitHub review handling, durable review-response task routing, real plan/code PR separation tests, end-to-end restart/session tests, and TUI interaction tests.

## Implementation Surface Found

- Services exist under `packages/opencode/src/workflow/`: `workflow.ts`, `state.ts`, `artifact.ts`, `scope.ts`, `approval.ts`, `executor.ts`, `session.ts`, `events.ts`, `github.ts`, and `review.ts`.
- CLI command family exists in `packages/opencode/src/cli/cmd/workflow.ts`.
- HTTP route definitions and handlers exist in `packages/opencode/src/server/routes/instance/httpapi/groups/workflow.ts` and `packages/opencode/src/server/routes/instance/httpapi/handlers/workflow.ts`.
- TUI workflow route exists in `packages/opencode/src/cli/cmd/tui/routes/workflow.tsx`.
- Config schema exists in `packages/opencode/src/config/workflow.ts`.
- Focused workflow tests exist under `packages/opencode/test/workflow` plus `packages/opencode/test/cli/cmd/tui/workflow-route.test.ts`.

## Missing Features And Gaps

### Planning

1. `workflow start` does not run a real planner to create a reviewed spec. It creates template `SPEC.md`, `TASKS.md`, and `IMPACT.md` content, creates or records a planner session, and then the CLI/HTTP path may submit a plan PR. The planner session is not prompted to inspect the repository and produce the required artifacts.
   - Evidence: `Workflow.start` writes initial artifacts via `artifact.writeInitialArtifacts(...)` and returns state in `packages/opencode/src/workflow/workflow.ts`.
   - Impact: The workflow can submit placeholder planning artifacts unless a user manually edits them first.

2. Planning role permissions are not strictly enforced by the start path. `WorkflowSession.createSession` has planner-scoped permissions, but `Workflow.start` creates the planner session directly with `permission: []`.
   - Impact: The invariant "planner may write workflow artifacts only" is not reliably enforced.

3. `revise plan` appends review feedback sections to artifacts, but it does not run an autonomous plan reviewer loop that interprets comments, edits the plan substantively, pushes revisions, and replies with evidence.
   - Evidence: `revisePlan` appends markdown sections to `SPEC.md`, `TASKS.md`, and `IMPACT.md`.

### Approval Gates

4. The workflow layer blocks execution until plan PR approval, approved hash, and approved plan commit are present. However, `WorkflowExecutor.run` has its own weaker approval check that only requires `approved_spec_hash` and plan PR metadata.
   - Evidence: executor-local `assertApprovedPlan` does not verify PR review state, approved plan commit, or current artifact hash.
   - Impact: Direct service usage can bypass the strict approval gate unless callers always go through `Workflow.run`.

5. Amendment approval updates `IMPACT.md` and recalculates `approved_spec_hash`, then may move back to `plan_approved` with a message saying re-approval is required.
   - Impact: This is internally inconsistent with the brief. Scope-changing amendments should invalidate the approved hash and require review before continuing, not create a new approved hash locally.

6. `approval_source` is recorded, but unsupported values only log a warning and then continue using the configured string in approval records.
   - Impact: Approval evidence is not strictly constrained to configured, supported GitHub review evidence or explicit alternatives.

### Execution And Scope Guard

7. Pre-edit scope enforcement is incomplete. The executor prompts a normal build session and checks `git diff` after the session work. It does not consistently create executor sessions through `WorkflowSession.createSession`, so the impact-boundary permissions defined there are not applied.
   - Evidence: executor sessions are created with `sessions.create({ agent: "build" })`; `Workflow.runApprovedPlan` also creates an executor session with `permission: []`.
   - Impact: Out-of-scope edits can be made before detection. The workflow may pause after drift, but the files have already been modified.

8. The executor loop is task-driven but shallow. It chooses unchecked tasks and prompts an agent, then marks tasks complete based on validation and post-hoc diff checks. It does not reliably update `TASKS.md` status/evidence fields, map files touched into deterministic task evidence, or create separate validator sessions.

9. Scope parsing is too narrow for the required artifact contract. `WorkflowScope.parseSpecContent` looks for `Requirements` and `Out of Scope`, while the required `SPEC.md` headings use `Goals` and `Non-Goals`. The generated template uses `Goals` and `Non-Goals`.
   - Impact: GitHub comments and steering instructions may be misclassified because the scope guard is not reading the canonical sections.

10. `IMPACT.md` has required sections, but the new-file behavior parser looks for a non-required `Scope Rules` section and the phrase `new files allowed`.
    - Impact: Expected new files and allowed directories are not enough to express the new-file policy described in the brief.

11. Config-level `github.enabled` is parsed but not used by `submitPlan`, `submitCode`, or `syncGithub`.
    - Impact: There is no explicit local-draft or no-GitHub behavior beyond `start --local-draft`.

### GitHub Review Loop

12. GitHub state sync fetches PRs, issue comments, review comments, reviews, review decisions, and merges local comment states. That part is present. Missing is the full loop that classifies every actionable comment into durable response tasks, routes in-scope work to the executor, replies with evidence after fixes, and repeats until approval.

13. `WorkflowReview.classifyComment` is keyword-based over the full spec/tasks/impact text and is not wired into the main `Workflow.syncGithub` guard path. The workflow service uses the separate `WorkflowScope.checkComment` classifier.
    - Impact: There are two classifiers with different behavior, and neither provides the durable response-task workflow required by the brief.

14. Out-of-scope comments can create `AMENDMENT.md`, but the amendment content often has empty `affected_files` unless path information is available. Scope-expanding natural-language comments do not produce a concrete scope delta.

15. Reply support exists in `WorkflowGithub.addReplyToComment`, but the primary workflow commands do not consistently reply to GitHub comments with evidence after plan revisions or code fixes.

### Sessions

16. Session records are durable in `STATE.json`, and CLI/TUI can list/open them. Missing or weak pieces:
    - Planner/executor sessions are not consistently created through the role-aware `WorkflowSession` service.
    - Validator sessions are not created during validation.
    - Code reviewer sessions are not created when code PR comments arrive.
    - Plan reviewer sessions do not have the expected permission profile: the current role map makes `plan_reviewer` read-only, but the brief expects it to update plan artifacts and push/reply.
    - Amendment sessions currently inherit executor-style allowed-path behavior when created through `WorkflowSession`, but the brief expects amendment sessions to write `AMENDMENT.md` and not continue execution before approval.

### TUI

17. The TUI exposes the expected workflow tabs: Spec, Tasks, Impact, GitHub, Sessions, Changes, Decisions, and Amendments.

18. Missing or incomplete TUI behavior:
    - No tested rendered workflow list/detail views.
    - No tested GitHub view behavior for reviewers, review state updates, comment statuses, or links.
    - No tested action flows for sync, revise, run, submit code, pause/resume, amendment approve/reject, session open, or steering.
    - The route polls local files every five seconds rather than subscribing to workflow events.
    - The session-open action routes to a normal session with a context prompt, but does not verify transcript rendering with workflow context.

### Events And Persistence

19. Most required event definitions exist. Missing or weak behavior:
    - Not every major state transition publishes a corresponding bus event.
    - Background sync scans `process.cwd()` rather than the active project/worktree directory, so persisted workflows outside the process cwd can be missed.
    - `DECISIONS.md` is updated for many operations, but not every meaningful transition has consistent actor, reason, PR evidence, and comment link fields.

### CLI/HTTP Surface

20. The expected CLI family is mostly present, with nested commands matching the requested command phrases:
    - `workflow submit plan`, `workflow sync github`, `workflow revise plan`, and `workflow submit code`.

21. HTTP routes mostly match the brief and include an extra `recover` route. Missing route-level coverage:
    - Handler integration tests for every route.
    - Error tests for missing approvals, scope drift, amendment blocking, and session lookup.
    - Authentication/authorization tests specific to workflow permissions.

22. Permission names use underscores in config (`workflow_submit_plan_pull_request`) while the brief lists dotted names (`workflow.submit_plan_pull_request`).
    - Impact: This may be acceptable in the local permission system, but it does not match the brief's literal permission names.

## Missing Tests

### Unit Tests

1. Planner artifact generation from an actual planner session, not just template creation.
2. Role permission enforcement for planner, plan reviewer, executor, validator, code reviewer, amendment, and recovery sessions.
3. Executor pre-edit permission scoping through `WorkflowSession.createSession`.
4. Executor approval gate parity with `Workflow.run`, including PR review state, approved plan commit, and artifact hash drift.
5. `SPEC.md` scope parsing using required headings: `Goals`, `Non-Goals`, expected files, CLI/TUI changes, GitHub PR flow, and test plan.
6. `IMPACT.md` parsing for expected new files, forbidden paths, dependency changes, review response boundaries, and rollback notes.
7. Amendment approval invalidating plan approval and requiring re-review when `SPEC.md`, `TASKS.md`, or `IMPACT.md` changes.
8. Unsupported `approval_source` behavior.
9. `github.enabled: false` behavior.
10. Background sync directory selection.

### Integration Tests

11. Start workflow from CLI and verify generated artifacts are substantive or planner-generated before PR submission.
12. Submit plan PR containing only workflow artifacts, with a fake or local GitHub boundary that verifies branch, PR body, PR number, URL, and head commit.
13. Sync and address plan PR issue comments, review comments, and requested changes end to end.
14. Refuse all execution paths before GitHub plan approval, including direct executor service usage or make that service private/non-bypassable.
15. Record approved spec hash and plan commit from GitHub, then reject execution after local artifact drift.
16. Execute approved workflow tasks through the real session/prompt stack and verify task evidence is persisted.
17. Submit a separate code PR and verify it links the approved plan PR/hash/commit.
18. Sync and address in-scope code PR comments through response tasks and executor sessions.
19. Pause and create amendments from scope-expanding GitHub comments and user steering.
20. Approve/reject amendments and verify correct re-review/resume semantics.
21. Complete only after code PR approval plus validation evidence.
22. Pause/resume across process restart using persisted `STATE.json` and visible sessions.
23. `workflow sessions` and `workflow session` opening with real stored sessions.
24. `workflow steer` with in-scope and out-of-scope instructions, including `DECISIONS.md` evidence.

### TUI Tests

25. Render workflow list with status, phase, review states, active session, last activity, and input-needed state.
26. Render workflow detail with approved hash/commit, PR links, validation, scope status, open comments, and actions.
27. Render GitHub view with plan/code PR metadata, reviewers, latest review time, comments, and comment statuses.
28. Render sessions view with role, id, agent, status, activity times, current task, files touched, linked GitHub comment, and input-needed state.
29. Open a workflow session transcript with workflow context.
30. Steer an active session from the TUI and verify decision logging and scope blocking.
31. Amendment blocking and approve/reject actions from the TUI.

## Current Test Coverage Found

Existing workflow tests cover useful pieces:

- State transitions and durable artifact creation.
- Plan-only validation and artifact structure validation.
- Approval evidence recording and amendment file creation.
- Scope guard path matching and simple comment classification.
- GitHub PR state normalization and comment merging.
- Session record helpers and session context.
- Steering decision logging.
- Execution refusal before plan approval through the workflow layer.
- Plan artifact hash drift after approval.
- Code approval requiring validation evidence.
- Some scope-expanding comment/amendment behavior.
- CLI/HTTP surface constants and TUI helper functions.

These are valuable, but they are mostly unit/surface tests. They do not yet prove the full autonomous workflow described by the brief.

## Acceptance Status

Not complete against the final acceptance checklist.

The current implementation likely satisfies or partially satisfies these checklist items:

- Workflow can start from CLI.
- Planning artifacts are created without intentional product code changes.
- Plan/code PR submission commands exist.
- GitHub PR state and comments can be synced.
- Execution is refused before plan approval through the main workflow service.
- Approved spec hash and approved plan commit can be recorded.
- Scope drift can pause execution after detection.
- Amendments can be created and approved/rejected.
- Sessions are persisted and visible in CLI/TUI.
- Steering is logged and can trigger amendment handling after approval.
- Workflow does not depend on GitHub Actions.

The checklist items that remain missing or not proven are:

- Real planner-generated artifacts before plan PR submission.
- Full plan PR comment/revision/evidence reply loop.
- Strict pre-edit scope enforcement.
- Complete autonomous executor loop with task evidence and validator sessions.
- Separate code PR behavior proven end to end.
- Full code review comment handling loop.
- Scope-expanding review feedback requiring re-approved amendments before continuation.
- Completion proven only after code PR approval and validation in an integration path.
- Pause/resume across restart with all failed/paused/completed sessions visible.
- Full TUI workflow/session/review/amendment interaction coverage.

