# Opencode Autonomous Workflow Audit Brief

Use this brief to audit whether the implementation matches the intended GitHub-reviewed autonomous workflow. The key requirement is strict separation between planning approval and code approval, with durable state, visible sessions, scope guards, and review evidence.

## Core Workflow

The feature adds an autonomous workflow layer over normal opencode sessions.

1. User starts a workflow.
2. Opencode creates planning artifacts only.
3. Opencode submits those artifacts to GitHub as a plan pull request.
4. Opencode tracks plan PR comments, review comments, review decisions, and requested changes.
5. Opencode revises the plan until the plan PR is approved.
6. The approved plan PR head becomes the approved implementation spec.
7. Only after plan approval, opencode executes code changes.
8. Opencode submits implementation work as a separate code change pull request.
9. Opencode tracks code PR comments and requested changes.
10. In-scope review feedback is addressed; scope-expanding feedback pauses for amendment approval.
11. Workflow completes only after the code PR is approved and validation has passed.

GitHub Actions are not required. GitHub is used for PRs, review state, comments, approval evidence, and audit links.

## Non-Negotiable Invariants

Audit these first.

1. Product code cannot change during planning.
2. Code execution cannot begin before GitHub approval of the plan PR.
3. Plan approval and implementation approval must use separate pull requests.
4. Approved scope is defined by `SPEC.md`, `TASKS.md`, `IMPACT.md`, the approved plan commit, and the approved artifact hash.
5. Changes after plan approval that modify `SPEC.md`, `TASKS.md`, or `IMPACT.md` must invalidate the approved hash and return to review or amendment.
6. Edits outside `IMPACT.md` scope must pause or fail; they cannot be silently applied.
7. GitHub comments and user steering instructions must pass the same scope guard.
8. Scope-expanding comments or steering instructions require `AMENDMENT.md` and approval before implementation continues.
9. Every workflow session must be visible and persisted across restart.
10. Major state transitions, approvals, comments, steering instructions, and amendments must be recorded in `DECISIONS.md`.
11. Workflow completion requires code PR approval plus required validation evidence.
12. The workflow must work without GitHub Actions.

## Command Surface

Expected CLI family:

```text
opencode workflow start
opencode workflow status
opencode workflow submit plan
opencode workflow sync github
opencode workflow revise plan
opencode workflow run
opencode workflow submit code
opencode workflow pause
opencode workflow resume
opencode workflow list
opencode workflow sessions
opencode workflow session
opencode workflow steer
opencode workflow branch
opencode workflow diff
opencode workflow commit
```

Audit behavior:

1. `start` creates a workflow id, artifact directory, planner session, required artifacts, plan branch, and plan PR unless local draft mode is explicit.
2. `status` shows workflow state, PR links and review states, approved spec version/hash, approved plan commit, current task, active session, validation result, changed files, open comments, and whether input is needed.
3. `submit plan` validates artifacts, confirms only planning artifacts changed, pushes the plan branch, creates or updates the plan PR, and stores PR metadata.
4. `sync github` fetches both PR states, issue comments, review comments, review decisions, requested changes, and records events.
5. `revise plan` updates plan artifacts from plan PR feedback, pushes revisions, replies with evidence, and stays in plan review until approved.
6. `run` refuses to execute unless the plan PR is approved and the local approved hash matches the approved PR head.
7. `submit code` verifies approved plan evidence and scope, pushes the code branch, creates or updates the code PR, and stores PR metadata.
8. `sessions` lists every session for the workflow.
9. `session` opens a normal session view with workflow context.
10. `steer` appends user guidance to the target session, logs it, and scope-checks it before action.

## Terminal Interface

Expected workflow area:

```text
Workflows
Spec
Tasks
Impact
GitHub
Sessions
Changes
Decisions
Amendments
```

Audit that the TUI exposes:

1. Workflow list with status, phase, PR review states, active session, last activity, and input-needed state.
2. Workflow detail with summary, approved spec version, approved plan commit, PR links, current task, validation, scope status, open comments, and actions.
3. GitHub view for plan and code PRs, including PR number, link, branch, head commit, review decision, reviewers, latest review time, comments, and comment status.
4. Sessions view with role, id, agent, status, activity times, current task, files touched, linked GitHub comment, and input-needed state.
5. Ability to open a session transcript with workflow context.
6. Ability to steer an active session from the TUI.

## Workflow Artifacts

Artifacts live under:

```text
.opencode/workflows/<workflow_id>
```

Required files:

```text
SPEC.md
TASKS.md
IMPACT.md
GITHUB.md
STATE.json
DECISIONS.md
AMENDMENT.md
```

`AMENDMENT.md` is created only when needed.

Audit required content:

1. `SPEC.md`: summary, goals, non-goals, current/proposed behavior, architecture, expected files, data model changes, CLI/TUI changes, GitHub PR flow, test plan, rollback plan, open questions.
2. `TASKS.md`: deterministic tasks with stable id, description, expected files, validation command, status, evidence, and related GitHub comment when applicable.
3. `IMPACT.md`: allowed changes, expected new files, forbidden paths, dependency changes, data model changes, security considerations, migration risk, user-visible changes, review response boundaries, rollback notes.
4. `GITHUB.md`: plan/code PR metadata, review state, open/addressed comments, out-of-scope comments, approved plan evidence, review response log.
5. `STATE.json`: workflow id/title/status/request, spec version, approved spec hash, approved plan commit, plan PR metadata, code PR metadata, current task, open GitHub comments, session records.
6. `DECISIONS.md`: timestamped entries for workflow id, session id, actor, event type, previous/new state, reason, evidence, PR number, and comment link when relevant.

## State Machine

Expected states:

```text
created
drafting_spec
submitting_plan_pull_request
awaiting_plan_review
addressing_plan_comments
plan_approved
executing
validating
submitting_code_pull_request
awaiting_code_review
addressing_code_comments
needs_amendment
paused
completed
failed
cancelled
```

Audit required transitions:

1. Planning moves from `created` to `drafting_spec` to `submitting_plan_pull_request` to `awaiting_plan_review`.
2. Plan comments move workflow to `addressing_plan_comments`, then back to `awaiting_plan_review`.
3. GitHub plan approval moves workflow to `plan_approved`.
4. Execution starts only from `plan_approved`.
5. Execution alternates between `executing` and `validating`.
6. Completed validated tasks move to `submitting_code_pull_request`, then `awaiting_code_review`.
7. Code review comments move to `addressing_code_comments`, then validation and PR resubmission.
8. Code PR approval plus validation moves workflow to `completed`.
9. Scope drift from execution, validation, or review handling moves to `needs_amendment`.
10. Active states can pause, fail, or cancel with durable state and decision log entries.

## Session Roles

Expected roles:

```text
planner
plan_reviewer
executor
validator
code_reviewer
amendment
recovery
```

Audit permissions by role:

1. Planner may inspect and write workflow artifacts only; it must not edit product source, install dependencies, or commit product code.
2. Plan reviewer may update plan artifacts, push plan branch updates, reply to plan comments, and log evidence; it must not edit product source or infer approval without GitHub evidence.
3. Executor may run only after plan approval, edit files allowed by `IMPACT.md`, run checks, update task status, log decisions, and request amendments.
4. Validator may run checks and summarize failures; it must not modify source unless explicitly promoted.
5. Code reviewer may classify code PR feedback, route in-scope work to executor, route scope expansion to amendment, reply with evidence, and log decisions.
6. Amendment session may write `AMENDMENT.md` and wait for approval; it must not continue execution before approval.

## Execution And Review Loops

Audit executor loop:

```text
load approved spec
load approved plan PR metadata
load task list
choose next unchecked task
read relevant files
prepare edit plan
check scope
apply edit
run targeted validation
summarize result
update task status
detect drift
continue, pause, amend, fail, submit code, or complete
```

Audit GitHub review loop:

```text
sync GitHub comments
classify comments
create response tasks
address in-scope comments
pause for amendment on scope expansion
push changes
reply to comments with evidence
wait for review state update
repeat until approval
```

Stop conditions:

1. Unresolved requested changes on plan PR or code PR.
2. All tasks complete and code PR approved.
3. Maximum step count reached.
4. Repeated validation failure.
5. User pause.
6. Scope drift.
7. Required user input.
8. Permission denial.
9. Unrecoverable error.

## Scope Guard

Audit that scope is checked before and after edits, and also for GitHub comments and steering instructions.

Rules:

1. Allow files listed in `IMPACT.md`.
2. Allow approved new files under approved directories.
3. Pause for amendment on unapproved dependency changes.
4. Fail or pause on forbidden paths.
5. Pause and write `AMENDMENT.md` on unknown paths.
6. Mark out-of-scope GitHub comments as amendment-required before applying changes.
7. Convert in-scope clarifications or tests into response tasks.

## Approval Evidence

Plan approval record must include workflow id, plan PR number/link, spec version, spec hash, head commit, approver, approval time, approved scope summary, and GitHub review evidence.

Code approval record must include workflow id, code PR number/link, approved plan PR number, approved spec hash, code head commit, validation evidence, approver, approval time, and GitHub review evidence.

Audit that approval is based on configured GitHub review state or explicitly configured alternatives, not on local assumptions.

## Services And Routes

Expected service modules:

```text
packages/opencode/src/workflow/workflow.ts
packages/opencode/src/workflow/state.ts
packages/opencode/src/workflow/artifact.ts
packages/opencode/src/workflow/scope.ts
packages/opencode/src/workflow/approval.ts
packages/opencode/src/workflow/executor.ts
packages/opencode/src/workflow/session.ts
packages/opencode/src/workflow/events.ts
packages/opencode/src/workflow/github.ts
packages/opencode/src/workflow/review.ts
```

Expected HTTP routes:

```text
GET    /workflow
POST   /workflow
GET    /workflow/:id
POST   /workflow/:id/submit-plan
POST   /workflow/:id/sync-github
POST   /workflow/:id/revise-plan
POST   /workflow/:id/run
POST   /workflow/:id/submit-code
POST   /workflow/:id/pause
POST   /workflow/:id/resume
GET    /workflow/:id/sessions
GET    /workflow/:id/sessions/:session_id
POST   /workflow/:id/sessions/:session_id/steer
POST   /workflow/:id/amendment/approve
```

Audit that services have clear ownership:

1. Workflow service: lifecycle and state machine.
2. State service: load/save `STATE.json`.
3. Artifact service: validate and write artifacts.
4. Scope service: enforce `IMPACT.md`.
5. Approval service: hashes, approvals, evidence.
6. Executor service: autonomous loop.
7. Session service: workflow/session mapping.
8. Event service: workflow and session events.
9. GitHub service: PRs, review state, comments, replies, links.
10. Review service: comment classification and response task state.

## Events

Expected workflow events:

```text
workflow.created
workflow.updated
workflow.plan_pull_request.submitted
workflow.plan_review.comment_received
workflow.plan_review.comment_addressed
workflow.plan_review.approved
workflow.execution.started
workflow.execution.paused
workflow.code_pull_request.submitted
workflow.code_review.comment_received
workflow.code_review.comment_addressed
workflow.code_review.approved
workflow.amendment.required
workflow.completed
workflow.failed
```

Expected session events:

```text
workflow.session.created
workflow.session.updated
workflow.session.paused
workflow.session.resumed
workflow.session.steered
workflow.session.completed
workflow.session.failed
```

Audit that TUI and CLI status can reflect these events live or after sync.

## Configuration And Permissions

Expected config in `opencode.json`:

```json
{
  "workflow": {
    "enabled": true,
    "max_steps": 50,
    "require_plan_pull_request_approval": true,
    "require_code_pull_request_approval": true,
    "allow_auto_amendment": false,
    "checks": ["test", "typecheck"],
    "allowed_paths": ["src", "packages", "docs"],
    "forbidden_paths": [".env", "secrets", "private"],
    "github": {
      "enabled": true,
      "remote": "origin",
      "plan_branch_prefix": "opencode/plan",
      "code_branch_prefix": "opencode/code",
      "plan_pull_request_base": "main",
      "code_pull_request_base": "main",
      "approval_source": "review_approval",
      "comment_sync_interval_seconds": 60
    }
  }
}
```

Expected permissions:

```text
workflow.submit_plan_pull_request
workflow.sync_github
workflow.address_plan_review
workflow.execute
workflow.submit_code_pull_request
workflow.address_code_review
workflow.amend
workflow.steer
workflow.commit
workflow.branch
```

Audit that prompts are explicit for PR submission, GitHub review handling, execution start, code PR submission, amendment approval, and steering.

## Test Coverage Expectations

Unit tests should cover:

1. State transitions.
2. Artifact parsing and validation.
3. Impact contract parsing.
4. GitHub state and comment classification.
5. Scope guard path matching.
6. Approval hash behavior and approval evidence.
7. Session role mapping.
8. Steering event logging.

Integration tests should cover:

1. Start workflow and generate artifacts.
2. Submit plan PR containing only workflow artifacts.
3. Sync and address plan PR comments.
4. Refuse execution before plan approval.
5. Record approved spec hash and plan commit.
6. Execute approved workflow tasks.
7. Submit separate code PR with approved plan evidence.
8. Sync and address in-scope code PR comments.
9. Pause and create amendment on scope expansion.
10. Approve amendment and resume.
11. Complete only after code PR approval.
12. Pause/resume across process restart.
13. List/open sessions from CLI and TUI.
14. Steer active session and prevent scope-bypassing steering.

TUI tests should cover workflow list/detail, GitHub view, sessions view, session opening, review state updates, steering decisions, and amendment blocking.

Run type checks from package directories, for example:

```text
cd packages/opencode && bun typecheck
```

Do not run tests from the repo root.

## Phased Delivery Checklist

1. Workflow state and artifacts: storage, required files, state machine, `start`, `status`, `sessions`.
2. Plan PR submission: plan branch, PR body, artifact-only validation, PR metadata.
3. Plan comment tracking: sync comments/reviews, response tasks, plan reviewer session, evidence replies.
4. Plan approval gate: approval detection, approved hash/commit/evidence, execution refusal before approval.
5. Executor loop: executor session, task selection, scope guard, validation, task evidence, stop conditions.
6. Code PR submission: separate branch/PR, approved plan links, spec hash, validation evidence.
7. Code review tracking: comment sync, code reviewer session, in-scope fixes, amendment pause for scope expansion.
8. Session visibility: workflow/session mapping, durable session state, CLI/TUI views.
9. Steering: CLI/TUI steering, decision log, scope guard, amendment on drift.
10. Amendments: `AMENDMENT.md`, amendment state, approval/rejection, resume behavior.
11. TUI polish: workflow panels for spec, tasks, impact, GitHub, changes, decisions, amendments.

## Final Acceptance Checklist

The implementation is complete only if all are true.

1. Workflow can start from CLI.
2. Planning artifacts are generated without product code changes.
3. Plan is submitted to GitHub as a plan PR.
4. Plan PR comments and review comments are tracked.
5. Plan artifacts are revised to address plan feedback.
6. Execution is refused before plan PR approval.
7. Approved spec hash and approved plan commit are recorded from GitHub.
8. Approved tasks execute autonomously.
9. Validation runs after task steps.
10. Scope drift pauses execution.
11. Amendments are created for scope changes.
12. User can approve or reject amendments.
13. Implementation is submitted as a separate code PR.
14. Code PR links to approved plan PR.
15. Code PR comments and review comments are tracked.
16. In-scope code review comments are addressed.
17. Scope-expanding code review comments pause for amendment.
18. Workflow completes only after code PR approval.
19. Workflow pauses and resumes across restart.
20. Planner, plan reviewer, executor, validator, code reviewer, amendment, and recovery sessions are visible.
21. User can open any workflow session.
22. User can steer an active workflow session.
23. Steering is logged in `DECISIONS.md`.
24. Steering cannot bypass approved scope.
25. Failed, paused, and completed sessions remain visible after restart.
26. Decision log explains every major state transition.
27. Full workflow works without GitHub Actions.