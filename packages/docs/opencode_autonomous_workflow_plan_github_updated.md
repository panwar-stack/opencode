# Opencode autonomous workflow loop plan

## 1. Purpose

This plan defines an autonomous workflow loop for opencode that uses GitHub as the review and approval surface. The workflow runs from the terminal interface and command line interface, creates a plan branch, submits the generated plan to GitHub as a plan pull request, tracks GitHub comments and review feedback, revises the plan until the plan pull request is approved, then triggers the code change workflow from the approved spec. The workflow then creates a separate code change pull request, tracks GitHub comments and review feedback, addresses those comments, and continues until the code change pull request is approved.

The workflow does not depend on GitHub Actions. GitHub is used for pull request submission, comment tracking, review state, approval evidence, and audit links.

## 2. Goals

1. Add a workflow command family to opencode.

2. Let opencode generate reviewable workflow artifacts before code changes begin.

3. Submit the generated plan to GitHub as a plan pull request.

4. Track GitHub comments, review comments, review states, and requested changes on the plan pull request.

5. Revise the plan artifacts until the plan pull request is approved.

6. Treat the approved plan pull request head as the approved spec source.

7. Trigger code changes only after the plan pull request is approved.

8. Create a separate code change pull request for implementation approval.

9. Track GitHub comments, review comments, review states, and requested changes on the code change pull request.

10. Address code review feedback until the code change pull request is approved.

11. Detect drift from the approved spec and pause for amendment approval.

12. Show every session that belongs to a workflow in the terminal interface and command line interface.

13. Let users steer active workflow sessions without bypassing approval rules.

14. Persist workflow state so work can be paused and resumed across process restarts.

## 3. Non goals

1. Do not require GitHub Actions.

2. Do not execute code changes before the plan pull request is approved.

3. Do not combine plan approval and code approval into one pull request.

4. Do not silently expand scope after approval.

5. Do not allow steering instructions or GitHub comments to bypass the approved spec.

6. Do not replace normal opencode sessions. Workflows should coordinate sessions, not remove them.

7. Do not auto merge pull requests unless a later policy explicitly adds that ability.

## 4. Product overview

The workflow feature adds a GitHub reviewed automation layer on top of existing opencode sessions.

A user starts a workflow from the command line or terminal interface. Opencode creates a planning session, inspects the repository, and writes workflow artifacts. After artifact validation passes, opencode creates a plan branch and submits a plan pull request to GitHub. The plan pull request contains only workflow artifacts and review context. Opencode watches the plan pull request for issue comments, review comments, and review decisions. When reviewers request changes, opencode creates or resumes a plan revision session, updates the plan artifacts, pushes the revision, and records the response in the decision log. This loop continues until GitHub shows that the plan pull request is approved.

After the plan pull request is approved, opencode records the approved spec version, approved artifact hash, plan pull request number, plan pull request head commit, and approval evidence. The workflow then creates or resumes an executor session, performs code changes in bounded steps, validates results, and creates a separate code change pull request. Opencode watches the code change pull request for comments, review comments, and requested changes. When reviewers request updates, opencode addresses the feedback if it remains inside the approved spec. If feedback expands scope, opencode pauses and creates an amendment for review.

The workflow owns the state machine. Sessions do the actual planning, plan revision, execution, validation, amendment, recovery, and GitHub response work.

## 5. User story for session visibility

As a user or engineer, I want to see all opencode sessions that belong to a workflow, so that I can inspect progress, understand which agent did what, see which GitHub comments were handled, and steer opencode when it starts moving in the wrong direction.

## 6. Command line interface

Add this command family.

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

### 6.1 Start

```text
opencode workflow start "Add password reset flow"
```

Behavior:

1. Create a workflow identifier.

2. Create the workflow artifact directory.

3. Start a planner session.

4. Generate the spec, task list, impact contract, state file, GitHub state file, and decision log.

5. Validate that no product source files changed during planning.

6. Create or select a plan branch.

7. Submit the plan branch to GitHub as a plan pull request unless the user explicitly starts in local draft mode.

8. Move the workflow to awaiting plan review.

### 6.2 Status

```text
opencode workflow status
opencode workflow status wf_123
```

Show:

1. Workflow status.

2. Plan pull request link and review state.

3. Code change pull request link and review state when it exists.

4. Approved spec version.

5. Approved plan commit.

6. Current task.

7. Active session.

8. Last validation result.

9. Files changed.

10. Open GitHub comments that still need action.

11. Whether user input is needed.

### 6.3 Submit plan

```text
opencode workflow submit plan wf_123
```

Behavior:

1. Validate required artifacts.

2. Confirm that the branch contains only allowed planning artifacts.

3. Push the plan branch.

4. Create or update the plan pull request.

5. Add the spec summary, task summary, impact summary, and workflow links to the pull request body.

6. Store the plan pull request number, link, branch, head commit, and review state.

7. Move the workflow to awaiting plan review.

### 6.4 Sync GitHub

```text
opencode workflow sync github wf_123
```

Behavior:

1. Fetch plan pull request state.

2. Fetch code change pull request state when it exists.

3. Fetch issue comments, review comments, review decisions, and requested changes.

4. Mark comments as open, addressed, out of scope, superseded, or blocked.

5. Create response tasks for actionable comments.

6. Record all GitHub review events in the decision log.

7. Advance workflow state when the plan pull request or code change pull request becomes approved.

### 6.5 Revise plan

```text
opencode workflow revise plan wf_123
```

Behavior:

1. Read open GitHub comments from the plan pull request.

2. Create or resume a plan revision session.

3. Update `SPEC.md`, `TASKS.md`, `IMPACT.md`, and related artifacts.

4. Push changes to the plan branch.

5. Reply to GitHub comments with a summary of how each comment was addressed.

6. Keep the workflow in awaiting plan review until the plan pull request is approved.

### 6.6 Run

```text
opencode workflow run wf_123
```

Behavior:

1. Refuse to run if the plan pull request is not approved.

2. Validate that the local approved spec hash matches the approved plan pull request head.

3. Create or resume an executor session.

4. Load the approved spec and task list.

5. Run the autonomous loop.

6. Create or update the code change branch.

### 6.7 Submit code

```text
opencode workflow submit code wf_123
```

Behavior:

1. Validate that execution is based on an approved plan pull request.

2. Validate that code changes remain inside `IMPACT.md`.

3. Push the code change branch.

4. Create or update the code change pull request.

5. Include the approved plan pull request link, approved spec hash, validation evidence, and task completion summary in the pull request body.

6. Store the code change pull request number, link, branch, head commit, and review state.

7. Move the workflow to awaiting code review.

### 6.8 Sessions

```text
opencode workflow sessions wf_123
```

Example output:

```text
Planner          ses_001   complete   Generated SPEC.md and opened plan pull request
Plan reviewer    ses_002   active     Addressing GitHub plan comments
Executor         ses_003   active     Editing src/auth/reset.ts
Validator        ses_004   waiting    Typecheck failed
Code reviewer    ses_005   waiting    Awaiting GitHub review comments
Amendment        ses_006   paused     Needs approval
```

### 6.9 Open one session

```text
opencode workflow session wf_123 ses_003
```

Behavior:

1. Open the normal opencode session view.

2. Add workflow context at the top.

3. Show approved spec version, current task, session role, plan pull request link, and code change pull request link when present.

### 6.10 Steer a session

```text
opencode workflow steer wf_123 ses_003 "Pause after the next edit and show the diff"
```

Behavior:

1. Append the user instruction to the target session.

2. Record the instruction in the decision log.

3. Recheck scope before acting on the instruction.

4. Pause and request an amendment if the instruction expands scope.

5. When relevant, post a GitHub comment response that explains why a requested change requires amendment approval.

## 7. Terminal interface

Add a workflow area to the terminal interface.

Primary views:

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

### 7.1 Workflow list

The workflow list shows:

1. Workflow title.

2. Status.

3. Current phase.

4. Plan pull request review state.

5. Code change pull request review state.

6. Active session.

7. Last activity.

8. Whether input is needed.

### 7.2 Workflow detail

The workflow detail view shows:

1. Summary.

2. Status.

3. Approved spec version.

4. Approved plan commit.

5. Plan pull request link.

6. Code change pull request link when it exists.

7. Current task.

8. Active session.

9. Validation result.

10. Scope status.

11. Open GitHub comments.

12. Available actions.

### 7.3 GitHub view

The GitHub view shows the review state of both pull requests.

Fields:

1. Pull request type, either plan or code change.

2. Pull request number.

3. Pull request link.

4. Branch.

5. Head commit.

6. Review decision.

7. Required reviewers.

8. Latest review time.

9. Open issue comments.

10. Open review comments.

11. Comment status.

Example:

```text
Workflow: wf_123 Add password reset flow

GitHub

Plan pull request        42   approved          All plan comments addressed
Code change pull request 43   changes requested 3 open comments
```

Selecting a comment opens the related opencode session context and the proposed response.

### 7.4 Sessions view

The Sessions view shows all sessions that belong to the workflow.

Fields:

1. Session role.

2. Session identifier.

3. Agent name.

4. Status.

5. Started at.

6. Last activity.

7. Current task.

8. Files touched.

9. Related GitHub comment when applicable.

10. Whether input is needed.

Example:

```text
Workflow: wf_123 Add password reset flow

Sessions

Planner          ses_001   complete   Generated SPEC.md
Plan reviewer    ses_002   active     Addressing plan pull request comment 1001
Executor         ses_003   active     Editing src/auth/reset.ts
Validator        ses_004   waiting    Typecheck failed
Code reviewer    ses_005   waiting    Awaiting code review
Amendment        ses_006   paused     Needs approval
```

When the user selects a session, opencode opens the session transcript with workflow context.

```text
Workflow: wf_123
Plan pull request: 42
Code change pull request: 43
Approved spec version: 3
Approved plan commit: abc123
Current task: Add password reset token model
Session: Executor ses_003
```

### 7.5 Steering from the terminal interface

The user can send instructions to an active session.

Examples:

```text
Do not change the database schema. Use the existing token table.
```

```text
Pause here and show me the diff before continuing.
```

```text
Focus only on the command line path. Leave the terminal interface for a later task.
```

Every steering instruction becomes a decision log entry. If the steering instruction is related to a GitHub review comment, the workflow links the instruction, session, and GitHub comment together.

## 8. Workflow artifacts

All project visible workflow artifacts live under this directory.

```text
.opencode/workflows/wf_123
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

### 8.1 SPEC.md

Required sections:

```text
Summary
Goals
Non goals
Current behavior
Proposed behavior
Architecture
Files expected to change
Data model changes
Command line changes
Terminal interface changes
GitHub pull request flow
Test plan
Rollback plan
Open questions
```

### 8.2 TASKS.md

The task list must be deterministic and executable.

Example:

```text
[ ] Add workflow storage module
[ ] Add command line command parser
[ ] Add terminal interface workflow panel
[ ] Add GitHub plan pull request submission
[ ] Add GitHub comment tracking
[ ] Add approval gate
[ ] Add scope guard
[ ] Add code pull request submission
[ ] Add tests
```

Each task should have:

1. Stable task identifier.

2. Description.

3. Expected files.

4. Validation command if applicable.

5. Status.

6. Evidence after completion.

7. Related GitHub comment when the task exists to address review feedback.

### 8.3 IMPACT.md

The impact contract defines what the executor is allowed to touch.

Required sections:

```text
Allowed file changes
Expected new files
Forbidden paths
Dependency changes
Data model changes
Security considerations
Migration risk
User visible changes
GitHub review response boundaries
Rollback notes
```

### 8.4 GITHUB.md

`GITHUB.md` records pull request and review state that is useful to humans.

Required sections:

```text
Plan pull request
Plan review state
Plan open comments
Plan addressed comments
Approved plan evidence
Code change pull request
Code review state
Code open comments
Code addressed comments
Out of scope comments
Review response log
```

Example entry:

```json
{
  "type": "plan_comment_addressed",
  "pull_request": 42,
  "comment_id": 1001,
  "comment_url": "https://github.com/org/repo/pull/42#discussion_r1001",
  "session_id": "ses_002",
  "summary": "Added rollback plan details to SPEC.md",
  "commit": "abc123"
}
```

### 8.5 STATE.json

Example:

```json
{
  "id": "wf_123",
  "title": "Add password reset flow",
  "status": "awaiting_code_review",
  "request": "Add password reset flow",
  "spec_version": 3,
  "approved_spec_hash": "hash_value",
  "approved_plan_commit": "abc123",
  "plan_pull_request": {
    "number": 42,
    "url": "https://github.com/org/repo/pull/42",
    "branch": "opencode/wf_123/plan",
    "head_commit": "abc123",
    "review_state": "approved"
  },
  "code_pull_request": {
    "number": 43,
    "url": "https://github.com/org/repo/pull/43",
    "branch": "opencode/wf_123/code",
    "head_commit": "def456",
    "review_state": "changes_requested"
  },
  "current_task_id": "task_004",
  "open_github_comments": [
    {
      "pull_request_type": "code",
      "comment_id": 2001,
      "url": "https://github.com/org/repo/pull/43#discussion_r2001",
      "status": "open",
      "assigned_session_id": "ses_005"
    }
  ],
  "sessions": [
    {
      "id": "ses_001",
      "role": "planner",
      "agent": "plan",
      "status": "complete",
      "created_at": "2026 05 09 10 00 00 UTC",
      "last_activity_at": "2026 05 09 10 03 00 UTC",
      "current_task_id": null
    },
    {
      "id": "ses_003",
      "role": "executor",
      "agent": "build",
      "status": "active",
      "created_at": "2026 05 09 10 20 00 UTC",
      "last_activity_at": "2026 05 09 10 33 00 UTC",
      "current_task_id": "task_004"
    }
  ]
}
```

### 8.6 DECISIONS.md

Decision log entries should include:

1. Time.

2. Workflow identifier.

3. Session identifier if applicable.

4. Actor.

5. Event type.

6. Previous state.

7. New state.

8. Reason.

9. Evidence or link to artifact.

10. GitHub pull request number when applicable.

11. GitHub comment link when applicable.

Example entry:

```json
{
  "type": "github_plan_comment_addressed",
  "workflow_id": "wf_123",
  "session_id": "ses_002",
  "pull_request": 42,
  "comment_url": "https://github.com/org/repo/pull/42#discussion_r1001",
  "message": "Added rollback plan details to SPEC.md.",
  "time": "2026 05 09 10 12 00 UTC"
}
```

## 9. State machine

Workflow states:

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

Required transitions:

1. `created` to `drafting_spec` when planning begins.

2. `drafting_spec` to `submitting_plan_pull_request` when required artifacts are written.

3. `submitting_plan_pull_request` to `awaiting_plan_review` when the plan pull request is created or updated.

4. `awaiting_plan_review` to `addressing_plan_comments` when GitHub comments or requested changes require plan updates.

5. `addressing_plan_comments` to `awaiting_plan_review` after revised plan artifacts are pushed and comments are answered.

6. `awaiting_plan_review` to `plan_approved` when GitHub shows the plan pull request is approved.

7. `plan_approved` to `executing` when the run command starts or automatic execution is enabled.

8. `executing` to `validating` after a task edit finishes.

9. `validating` to `executing` when checks pass and tasks remain.

10. `validating` to `submitting_code_pull_request` when checks pass and all tasks are complete.

11. `submitting_code_pull_request` to `awaiting_code_review` when the code change pull request is created or updated.

12. `awaiting_code_review` to `addressing_code_comments` when GitHub comments or requested changes require code updates.

13. `addressing_code_comments` to `validating` after code review changes are applied.

14. `validating` to `submitting_code_pull_request` after review changes pass validation.

15. `awaiting_code_review` to `completed` when GitHub shows the code change pull request is approved and all required workflow checks have passed.

16. `executing`, `validating`, or `addressing_code_comments` to `needs_amendment` when scope drift is detected.

17. Any active state to `paused` when the user pauses.

18. Any active state to `failed` on unrecoverable error.

19. Any non terminal state to `cancelled` when the user cancels.

## 10. Agent roles

### 10.1 Planner session

Allowed:

1. Read files.

2. Search files.

3. Inspect repository structure.

4. Write workflow artifacts only.

5. Ask questions.

6. Prepare the plan pull request body.

Denied:

1. Edit product source files.

2. Run destructive commands.

3. Install dependencies.

4. Commit product code changes.

Planner output must pass artifact validation before the workflow can submit the plan pull request.

### 10.2 Plan reviewer session

Allowed:

1. Read GitHub comments on the plan pull request.

2. Group comments by required artifact change.

3. Update workflow artifacts.

4. Push plan branch updates.

5. Reply to GitHub comments with evidence.

6. Record comment handling in `GITHUB.md` and `DECISIONS.md`.

Denied:

1. Edit product source files.

2. Treat plan approval as granted without GitHub approval evidence.

3. Ignore requested changes without marking them as out of scope or blocked.

### 10.3 Executor session

Allowed only after plan pull request approval:

1. Edit files allowed by `IMPACT.md`.

2. Run approved checks.

3. Update task status.

4. Write decision log entries.

5. Request amendments.

6. Prepare the code change pull request body.

Denied:

1. Change files outside approved scope.

2. Add dependencies not listed in `IMPACT.md`.

3. Continue after a failed scope guard.

4. Mark tasks complete without evidence.

5. Start implementation before plan pull request approval.

### 10.4 Validator session

Allowed:

1. Run configured validation commands.

2. Summarize failures.

3. Link failures to tasks and GitHub comments.

4. Recommend whether the executor should retry, pause, or request amendment.

Denied:

1. Modify source files unless explicitly promoted to executor role.

### 10.5 Code reviewer session

Allowed:

1. Read GitHub comments on the code change pull request.

2. Create response tasks for comments that fit inside the approved spec.

3. Route in scope code feedback to the executor.

4. Route scope expanding feedback to the amendment session.

5. Reply to GitHub comments after changes are pushed.

6. Record comment handling in `GITHUB.md` and `DECISIONS.md`.

Denied:

1. Apply scope expanding feedback without amendment approval.

2. Mark comments addressed without code evidence, explanation, or out of scope rationale.

### 10.6 Amendment session

Allowed:

1. Write `AMENDMENT.md`.

2. Explain why scope changed.

3. List additional files or tasks.

4. Link the GitHub comment that caused the amendment when applicable.

5. Wait for approval.

Denied:

1. Continue execution before amendment approval.

## 11. Autonomous execution loop

The executor runs a bounded loop after the plan pull request is approved.

```text
load approved spec
load approved plan pull request metadata
load task list
choose next unchecked task
read relevant files
prepare local edit plan
check scope
apply edit
run targeted validation
summarize result
update task status
detect drift
continue, pause, amend, fail, submit code, or complete
```

Review handling loops:

```text
sync GitHub comments
classify comments
create response tasks
address in scope comments
pause for amendment when comments expand scope
push changes
reply to comments
wait for review state update
repeat until approval
```

Stop conditions:

1. The plan pull request has unresolved requested changes.

2. The code change pull request has unresolved requested changes.

3. All tasks are complete and the code change pull request is approved.

4. The workflow reaches the maximum step count.

5. Validation fails repeatedly.

6. The user pauses the workflow.

7. Scope drift is detected.

8. The agent needs user input.

9. A permission is denied.

10. An unrecoverable error occurs.

## 12. Scope guard

The scope guard runs before and after edits. It also evaluates GitHub review comments and steering instructions.

Rules:

1. If a file is listed in `IMPACT.md`, allow the edit.

2. If a new file is under an allowed directory and new files are allowed, allow the edit.

3. If a dependency file changes without approval, pause and request amendment.

4. If a forbidden path is touched, fail or pause based on severity.

5. If an unknown path is touched, write `AMENDMENT.md` and pause.

6. If a GitHub comment requests work outside the approved spec, mark it as requiring amendment and pause before applying it.

7. If a GitHub comment requests a valid clarification or test inside scope, create a response task and continue.

Steering instructions go through the same guard.

Example:

```text
GitHub comment: Also add single sign on while you are here.
Result: pause workflow and write AMENDMENT.md because this expands scope.
```

## 13. Approval model

Execution cannot begin without GitHub approval of the plan pull request.

Plan approval records:

1. Workflow identifier.

2. Plan pull request number.

3. Plan pull request link.

4. Spec version.

5. Spec hash.

6. Head commit.

7. Approver.

8. Approval time.

9. Summary of approved scope.

10. Review evidence from GitHub.

When `SPEC.md`, `TASKS.md`, or `IMPACT.md` changes after plan approval, the approved hash no longer matches. The workflow must return to plan review or amendment approval.

Code approval records:

1. Workflow identifier.

2. Code change pull request number.

3. Code change pull request link.

4. Approved plan pull request number.

5. Approved spec hash.

6. Code head commit.

7. Validation evidence.

8. Approver.

9. Approval time.

10. Review evidence from GitHub.

The workflow is complete only after the code change pull request is approved and all workflow validation requirements have passed.

## 14. Session model

A workflow can own many sessions.

Common roles:

```text
planner
plan_reviewer
executor
validator
code_reviewer
amendment
recovery
```

Session statuses:

```text
created
active
waiting
paused
complete
failed
cancelled
```

Each session record should include:

1. Session identifier.

2. Role.

3. Agent.

4. Status.

5. Created time.

6. Last activity time.

7. Current task identifier.

8. Files touched.

9. Parent workflow identifier.

10. Related plan pull request comment when applicable.

11. Related code change pull request comment when applicable.

12. Whether user input is needed.

## 15. Steering model

Steering is a first class workflow event.

When the user steers a session:

1. The message is added to the target session.

2. The message is written to `DECISIONS.md`.

3. The executor incorporates the instruction only if it remains inside approved scope.

4. If the instruction changes scope, the workflow pauses and creates an amendment.

5. The terminal interface updates the session status.

6. Related GitHub comments are linked when the steering instruction is part of review response handling.

Supported steering actions:

1. Continue with guidance.

2. Pause after next step.

3. Show diff.

4. Avoid a file or directory.

5. Prefer a particular approach.

6. Ask for a new plan.

7. Request amendment.

8. Reply to a GitHub comment with an explanation.

## 16. Server and service design

Add workflow services.

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

Add server routes.

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

Service responsibilities:

1. Workflow service manages lifecycle.

2. State service loads and saves `STATE.json`.

3. Artifact service validates and writes workflow files.

4. Scope service enforces `IMPACT.md`.

5. Approval service manages hashes, pull request approvals, and approval evidence.

6. Executor service runs the autonomous loop.

7. Session service links opencode sessions to workflow roles.

8. Event service emits workflow and session events.

9. GitHub service creates pull requests, fetches review state, fetches comments, posts replies, and records links.

10. Review service classifies comments, creates response tasks, and marks comments as open, addressed, blocked, superseded, or out of scope.

## 17. Events

Workflow events:

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

Workflow session events:

```text
workflow.session.created
workflow.session.updated
workflow.session.paused
workflow.session.resumed
workflow.session.steered
workflow.session.completed
workflow.session.failed
```

The terminal interface subscribes to these events and updates live.

## 18. Configuration

Project configuration can live in `opencode.json`.

Example:

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

Configuration behavior:

1. `enabled` turns the feature on or off.

2. `max_steps` bounds autonomous execution.

3. `require_plan_pull_request_approval` prevents implementation before plan approval.

4. `require_code_pull_request_approval` prevents completion before code approval.

5. `allow_auto_amendment` controls whether opencode can draft amendments without asking first.

6. `checks` defines validation commands.

7. `allowed_paths` gives default scope for workflows.

8. `forbidden_paths` blocks sensitive locations.

9. `github.enabled` turns GitHub submission and review tracking on or off.

10. `github.approval_source` defines whether approval comes from review approval, an approval label, or repository rules.

## 19. GitHub pull request support

GitHub support is required for the default workflow review path. GitHub Actions are not required.

Commands:

```text
opencode workflow submit plan wf_123
opencode workflow sync github wf_123
opencode workflow submit code wf_123
opencode workflow branch wf_123
opencode workflow diff wf_123
opencode workflow commit wf_123
```

Default behavior:

1. The plan is submitted to GitHub as a plan pull request.

2. The workflow watches the plan pull request for comments, review comments, and requested changes.

3. The workflow addresses plan feedback and pushes revisions until the plan pull request is approved.

4. The approved plan pull request becomes the source of truth for implementation.

5. The code changes are submitted to GitHub as a separate code change pull request.

6. The workflow watches the code change pull request for comments, review comments, and requested changes.

7. The workflow addresses code feedback and pushes revisions until the code change pull request is approved.

8. Pull request links and comment links are written to `GITHUB.md`, `STATE.json`, and `DECISIONS.md`.

Local behavior:

1. Local branch, diff, and commit commands still work.

2. Local workflow files are useful for inspection and recovery.

3. GitHub review state is the approval source when GitHub mode is enabled.

4. A local only mode may be retained for repositories that do not use GitHub, but it is not the default path described by this plan.

## 20. Permissions

Add workflow permissions.

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

Permission prompts should be explicit.

Examples:

```text
Submit this plan to GitHub as a plan pull request?
```

```text
Address GitHub plan comment 1001 by updating SPEC.md?
```

```text
Start code changes from the approved plan pull request?
```

```text
Submit this implementation to GitHub as a code change pull request?
```

```text
Address GitHub code review comment 2001 by editing src/auth/reset.ts?
```

```text
Approve amendment that adds package.json to scope?
```

```text
Send this steering instruction to executor session ses_003?
```

## 21. Testing plan

### 21.1 Unit tests

1. State transitions.

2. Artifact parsing.

3. Spec validation.

4. Task list validation.

5. Impact contract parsing.

6. GitHub state parsing.

7. GitHub comment classification.

8. Scope guard path matching.

9. Approval hash behavior.

10. Plan pull request approval evidence.

11. Code change pull request approval evidence.

12. Session role mapping.

13. Steering event logging.

### 21.2 Integration tests

1. Start workflow and generate artifacts.

2. Submit plan pull request with only workflow artifacts.

3. Sync GitHub comments from the plan pull request.

4. Address plan comments and push updated artifacts.

5. Refuse execution before plan pull request approval.

6. Record approved spec hash from approved plan pull request head.

7. Run approved workflow to completion.

8. Submit code change pull request with approved plan evidence.

9. Sync GitHub comments from the code change pull request.

10. Address code review comments that remain inside scope.

11. Pause and create amendment when a code review comment expands scope.

12. Approve amendment and resume execution.

13. Mark workflow complete only after code change pull request approval.

14. Pause and resume after process restart.

15. List workflow sessions from command line.

16. Open workflow session from terminal interface.

17. Steer active session and record decision.

18. Confirm steering cannot expand scope without amendment.

### 21.3 Terminal interface tests

1. Workflow list renders expected states.

2. Workflow detail shows active session.

3. GitHub view shows plan and code change pull request state.

4. GitHub view shows open and addressed comments.

5. Sessions tab shows all linked sessions.

6. Selecting a session opens the transcript with workflow context.

7. Plan review state updates when GitHub approval arrives.

8. Code review state updates when GitHub approval arrives.

9. Steering action writes a decision log event.

10. Amendment review blocks execution until approval.

## 22. Implementation phases

### Phase 1: Workflow state and artifacts

Deliver:

1. Workflow directory creation.

2. `STATE.json`.

3. `SPEC.md`.

4. `TASKS.md`.

5. `IMPACT.md`.

6. `GITHUB.md`.

7. `DECISIONS.md`.

8. Basic state machine.

9. Command line commands for start, status, and sessions.

Acceptance:

1. A workflow can be started.

2. Required artifacts are created.

3. The workflow can enter drafting spec.

4. The workflow records GitHub fields even before pull requests exist.

### Phase 2: Plan pull request submission

Deliver:

1. Plan branch creation.

2. Plan pull request creation.

3. Plan pull request body generation.

4. Plan pull request state persistence.

5. Validation that plan pull requests include workflow artifacts only.

Acceptance:

1. The workflow can submit a plan pull request.

2. The plan pull request links to `SPEC.md`, `TASKS.md`, `IMPACT.md`, and `GITHUB.md`.

3. The workflow stores the pull request number, link, branch, and head commit.

4. Product source files are not changed during planning.

### Phase 3: GitHub plan comment tracking

Deliver:

1. GitHub comment sync.

2. Review comment sync.

3. Review decision sync.

4. Plan reviewer session creation.

5. Plan comment response tasks.

6. Comment status tracking.

Acceptance:

1. The workflow sees plan pull request comments.

2. The workflow updates plan artifacts to address comments.

3. The workflow replies to comments with evidence.

4. The workflow keeps waiting until the plan pull request is approved.

### Phase 4: Plan approval gate

Deliver:

1. Plan pull request approval detection.

2. Approved spec hash.

3. Approved plan commit.

4. Approval evidence record.

5. Execution gate.

Acceptance:

1. The workflow refuses implementation before plan pull request approval.

2. The workflow records the approved plan pull request state.

3. The workflow starts execution only from the approved spec.

### Phase 5: Executor loop

Deliver:

1. Executor session creation.

2. Task selection.

3. Scope guard.

4. Edit and validate loop.

5. Task completion updates.

6. Stop conditions.

Acceptance:

1. Approved workflows can execute.

2. Execution stops on validation failure.

3. Execution stops on scope drift.

4. Completed tasks have evidence.

### Phase 6: Code change pull request submission

Deliver:

1. Code change branch creation.

2. Code change pull request creation.

3. Code change pull request body generation.

4. Links to approved plan pull request and spec hash.

5. Validation evidence summary.

Acceptance:

1. The workflow submits implementation work as a separate code change pull request.

2. The code change pull request links to the approved plan pull request.

3. The code change pull request includes validation evidence.

4. The workflow enters awaiting code review.

### Phase 7: GitHub code review tracking

Deliver:

1. Code review comment sync.

2. Code reviewer session creation.

3. In scope review response tasks.

4. Out of scope comment detection.

5. Comment replies with evidence.

Acceptance:

1. The workflow sees code change pull request comments.

2. The workflow addresses in scope comments.

3. The workflow pauses for amendment on scope expanding comments.

4. The workflow continues until the code change pull request is approved.

### Phase 8: Session visibility

Deliver:

1. Workflow to session mapping.

2. Sessions stored in `STATE.json`.

3. Command line session listing.

4. Command line session opening.

5. Terminal interface Sessions view.

Acceptance:

1. Every workflow session is visible.

2. Session status survives restart.

3. The user can inspect planner, plan reviewer, executor, validator, code reviewer, amendment, and recovery sessions.

### Phase 9: Steering

Deliver:

1. Command line steering command.

2. Terminal interface steering action.

3. Steering event logging.

4. Scope guarded steering.

5. Pause on steering drift.

Acceptance:

1. The user can steer an active session.

2. Steering appears in the session transcript.

3. Steering appears in `DECISIONS.md`.

4. Scope expanding steering creates an amendment instead of applying directly.

### Phase 10: Amendments

Deliver:

1. `AMENDMENT.md`.

2. Amendment state.

3. Amendment approval.

4. Resume from amendment.

5. GitHub comment links that caused the amendment.

Acceptance:

1. Drift creates an amendment.

2. Execution pauses until amendment approval.

3. Approved amendments update the approved scope.

4. Rejected amendments keep the workflow paused or return to revision.

### Phase 11: Terminal interface polish

Deliver:

1. Workflow panel.

2. Spec review.

3. Task view.

4. Impact view.

5. GitHub view.

6. Change view.

7. Decision log view.

8. Amendment review.

Acceptance:

1. The full workflow can be controlled from the terminal interface.

2. Users can inspect sessions without leaving the workflow.

3. Users can approve, pause, resume, steer, and review amendments.

4. Users can see plan pull request and code change pull request review state.

## 23. Acceptance criteria

The final feature is complete when all of the following are true.

1. A user can start a workflow from the command line.

2. Opencode generates spec artifacts without modifying product code.

3. Opencode submits the plan to GitHub as a plan pull request.

4. Opencode tracks GitHub comments and review comments on the plan pull request.

5. Opencode revises the plan artifacts to address plan comments.

6. Opencode refuses to execute before the plan pull request is approved.

7. Opencode records the approved spec hash and approved plan commit from GitHub.

8. Opencode executes approved tasks autonomously.

9. Opencode validates work after task steps.

10. Opencode pauses on scope drift.

11. Opencode creates amendments for scope changes.

12. The user can approve or reject amendments.

13. Opencode submits implementation work to GitHub as a separate code change pull request.

14. The code change pull request links to the approved plan pull request.

15. Opencode tracks GitHub comments and review comments on the code change pull request.

16. Opencode addresses in scope code review comments.

17. Opencode pauses for amendment when code review comments expand scope.

18. The workflow is marked complete only after the code change pull request is approved.

19. The workflow can be paused and resumed across process restarts.

20. Every planner, plan reviewer, executor, validator, code reviewer, amendment, and recovery session is visible.

21. The user can open any workflow session.

22. The user can steer an active workflow session.

23. Steering instructions are recorded in the decision log.

24. Steering instructions cannot bypass approved scope.

25. Failed, paused, and completed sessions remain visible after restart.

26. The decision log explains every major state transition.

27. The full workflow works without GitHub Actions.

## 24. Open questions

1. Should the plan pull request be merged before execution, or is approval enough?

2. Should the code change branch start from the plan pull request branch, the default branch, or the approved plan commit?

3. Should workflow artifacts be committed by default, ignored by default, or configurable after the code change pull request is complete?

4. Should completed workflow artifacts be archived outside the repository after completion?

5. Should the terminal interface allow multiple active workflows at once?

6. Should validation run in the executor session or always in a separate validator session?

7. Should steering require explicit permission prompts, or should it be treated like normal session input?

8. Should `AMENDMENT.md` replace the approved spec after approval, or should it layer on top as a separate approved scope delta?

9. Should workflow sessions be hidden from the normal session list, grouped under workflows, or shown in both places?

10. Should the workflow reply to every GitHub comment automatically, or prepare replies for user approval?

11. Should GitHub approval come only from review approval, or should configured labels and repository rules also count?

## 25. Recommended first pull request

Build the smallest useful slice.

Scope:

1. Add workflow artifact storage.

2. Add workflow state machine.

3. Add command line commands for start, status, submit plan, sync GitHub, and sessions.

4. Add `GITHUB.md`.

5. Add plan branch creation.

6. Add plan pull request creation.

7. Add GitHub comment sync for the plan pull request.

8. Add session mapping in `STATE.json`.

9. Add decision log.

10. Use existing sessions without changing the terminal interface yet.

This gives opencode a durable workflow backbone, makes GitHub the source of review and approval, and creates a safe foundation for the later executor and code change pull request phases.
