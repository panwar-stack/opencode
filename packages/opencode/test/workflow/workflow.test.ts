import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Stream } from "effect"
import { mkdir } from "fs/promises"
import path from "path"
import { Bus } from "../../src/bus"
import { WorkflowApproval } from "../../src/workflow/approval"
import { tmpdir, provideInstance } from "../fixture/fixture"
import { WorkflowArtifact } from "../../src/workflow/artifact"
import { WorkflowGithub } from "../../src/workflow/github"
import { WorkflowScope } from "../../src/workflow/scope"
import { WorkflowState } from "../../src/workflow/state"
import { Workflow } from "../../src/workflow/workflow"
import { WorkflowExecutor } from "../../src/workflow/executor"
import { WorkflowReview } from "../../src/workflow/review"
import { Session } from "../../src/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"
import { ProjectID } from "../../src/project/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Config } from "../../src/config/config"

const mockWfSessionInfo: Session.Info = {
  id: "ses_test_wf" as SessionID,
  slug: "test-wf",
  projectID: "p_test_wf" as ProjectID,
  directory: "",
  title: "Test WF Session",
  version: "0.0.0",
  time: { created: 0, updated: 0 },
}

const mockWfPromptResponse: MessageV2.WithParts = {
  info: {
    id: "msg_test_wf_prompt" as MessageID,
    sessionID: "ses_test_wf" as SessionID,
    role: "user" as const,
    time: { created: 0 },
    agent: "build",
    model: { providerID: "p_test" as ProviderID, modelID: "m_test" as ModelID },
  },
  parts: [],
}

const mockWfSession: Session.Interface = {
  create: () => Effect.succeed(mockWfSessionInfo),
  list: () => Effect.succeed([]),
  fork: () => Effect.die("not implemented"),
  touch: () => Effect.void,
  get: () => Effect.die("not implemented"),
  setTitle: () => Effect.void,
  setArchived: () => Effect.void,
  setPermission: () => Effect.void,
  setRevert: () => Effect.void,
  clearRevert: () => Effect.void,
  setSummary: () => Effect.void,
  diff: () => Effect.succeed([]),
  messages: () => Effect.succeed([]),
  children: () => Effect.succeed([]),
  remove: () => Effect.die("not implemented"),
  updateMessage: (msg: any) => Effect.succeed(msg),
  removeMessage: () => Effect.succeed("" as MessageID),
  removePart: () => Effect.succeed("" as any),
  getPart: () => Effect.succeed(undefined),
  updatePart: (part: any) => Effect.succeed(part),
  updatePartDelta: () => Effect.void,
  findMessage: () => Effect.succeed(Option.none()),
}

const mockWfSessionPrompt: SessionPrompt.Interface = {
  cancel: () => Effect.void,
  prompt: () => Effect.succeed(mockWfPromptResponse),
  loop: () => Effect.succeed(mockWfPromptResponse),
  shell: () => Effect.succeed(mockWfPromptResponse),
  command: () => Effect.succeed(mockWfPromptResponse),
  resolvePromptParts: () => Effect.succeed([{ type: "text", text: "mock" } as any]),
}

const mockWfConfig: Config.Interface = {
  get: () => Effect.succeed({ workflow: { checks: [] } } as Config.Info),
  getGlobal: () => Effect.succeed({} as Config.Info),
  getConsoleState: () => Effect.succeed({} as any),
  update: () => Effect.void,
  updateGlobal: () => Effect.succeed({ info: {} as Config.Info, changed: false }),
  invalidate: () => Effect.void,
  directories: () => Effect.succeed([]),
  waitForDependencies: () => Effect.void,
}

const testBus = Bus.Service.of({
  publish: () => Effect.void,
  subscribe: () => Stream.empty as never,
  subscribeAll: () => Stream.empty as never,
  subscribeCallback: () => Effect.succeed(() => {}),
  subscribeAllCallback: () => Effect.succeed(() => {}),
} as import("../../src/bus").Interface)

const mockGithub = (state: WorkflowState.PullRequestState): WorkflowGithub.Interface => ({
  createPullRequest: () =>
    Effect.succeed({
      number: state.number ?? 1,
      url: state.url ?? "https://github.com/acme/repo/pull/1",
      head_branch: state.branch ?? "branch",
      head_commit: state.head_commit ?? "head",
      review_state: state.review_state,
    }),
  getPullRequest: () =>
    Effect.succeed({
      number: state.number ?? 1,
      url: state.url ?? "https://github.com/acme/repo/pull/1",
      head_branch: state.branch ?? "branch",
      head_commit: state.head_commit ?? "head",
      review_state: state.review_state,
    }),
  listIssueComments: () => Effect.succeed([]),
  listReviewComments: () => Effect.succeed([]),
  getReviews: () => Effect.succeed(state.review_state),
  addComment: () => Effect.void,
  addReplyToComment: () => Effect.void,
  getPullRequestState: () => Effect.succeed(state),
})

const disabledGithub: WorkflowGithub.Interface = {
  createPullRequest: () => Effect.die("unexpected GitHub createPullRequest call"),
  getPullRequest: () => Effect.die("unexpected GitHub getPullRequest call"),
  listIssueComments: () => Effect.die("unexpected GitHub listIssueComments call"),
  listReviewComments: () => Effect.die("unexpected GitHub listReviewComments call"),
  getReviews: () => Effect.die("unexpected GitHub getReviews call"),
  addComment: () => Effect.die("unexpected GitHub addComment call"),
  addReplyToComment: () => Effect.die("unexpected GitHub addReplyToComment call"),
  getPullRequestState: () => Effect.die("unexpected GitHub getPullRequestState call"),
}

const runWorkflowWithGithub = <A, E>(effect: Effect.Effect<A, E, Workflow.Service>, github: WorkflowGithub.Interface, directory?: string) =>
  Effect.runPromise(
    (directory ? effect.pipe(provideInstance(directory)) : effect).pipe(
      Effect.provide(
        Workflow.layer.pipe(
          Layer.provide(Layer.succeed(WorkflowGithub.Service, WorkflowGithub.Service.of(github))),
          Layer.provide(WorkflowApproval.defaultLayer),
          Layer.provide(WorkflowScope.defaultLayer),
          Layer.provide(WorkflowArtifact.defaultLayer),
          Layer.provide(Bus.layer),
        ),
      ),
    ),
  )

const runWorkflowWithGithubDisabled = <A, E>(effect: Effect.Effect<A, E, Workflow.Service>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Workflow.layer.pipe(
          Layer.provide(Layer.succeed(WorkflowGithub.Service, WorkflowGithub.Service.of(disabledGithub))),
          Layer.provide(WorkflowApproval.defaultLayer),
          Layer.provide(WorkflowScope.defaultLayer),
          Layer.provide(WorkflowArtifact.defaultLayer),
          Layer.provide(Bus.layer),
        ),
      ),
      Effect.provideService(Config.Service, {
        ...mockWfConfig,
        get: () => Effect.succeed({ workflow: { checks: [], github: { enabled: false } } } as Config.Info),
      }),
    ),
  )

const runWorkflowWithConfig = <A, E>(effect: Effect.Effect<A, E, Workflow.Service>, config: Config.Info, directory?: string) =>
  Effect.runPromise(
    (directory ? effect.pipe(provideInstance(directory)) : effect).pipe(
      Effect.provide(
        Workflow.layer.pipe(
          Layer.provide(Layer.succeed(WorkflowGithub.Service, WorkflowGithub.Service.of(disabledGithub))),
          Layer.provide(WorkflowApproval.defaultLayer),
          Layer.provide(WorkflowScope.defaultLayer),
          Layer.provide(WorkflowArtifact.defaultLayer),
          Layer.provide(Bus.layer),
        ),
      ),
      Effect.provideService(Config.Service, {
        ...mockWfConfig,
        get: () => Effect.succeed(config),
      }),
    ),
  )

async function writeReviewedPlanArtifacts(directory: string, workflowID: string) {
  await Promise.all([
    WorkflowArtifact.writeArtifact(
      directory,
      workflowID,
      "SPEC.md",
      `# Reviewed Plan

## Summary

Implement the requested workflow behavior with reviewed plan artifacts.

## Goals

- Add the workflow behavior requested by the user.

## Non-Goals

- Do not change unrelated command behavior.

## Current Behavior

- The current workflow path can continue before reviewed artifacts are ready.

## Proposed Behavior

- The workflow path waits for reviewed artifacts before plan submission.

## Architecture

- Update workflow services and CLI command handling.

## Expected Files

- packages/opencode/src/workflow/workflow.ts
- packages/opencode/src/cli/cmd/workflow.ts

## Data Model Changes

- Persist session status in the workflow state file.

## CLI/TUI Changes

- The start command leaves the plan in drafting state.

## GitHub PR Flow

- The plan pull request is submitted after reviewed artifacts exist.

## Test Plan

- Run bun test test/workflow/workflow.test.ts.

## Rollback Plan

- Revert the workflow service and CLI changes.

## Open Questions

- None.
`,
    ),
    WorkflowArtifact.writeArtifact(
      directory,
      workflowID,
      "TASKS.md",
      `# Tasks

- [ ] task_001 | Update workflow start gating | files: packages/opencode/src/workflow/workflow.ts | validation: bun typecheck | status: pending | evidence: none | github: none
`,
    ),
    WorkflowArtifact.writeArtifact(
      directory,
      workflowID,
      "IMPACT.md",
      `# Impact

## Allowed Paths

- packages/opencode/src/workflow/workflow.ts
- packages/opencode/src/cli/cmd/workflow.ts

## Expected New Files

- none

## Forbidden Paths

- .env

## Dependency Changes

- No dependency changes.

## Data Model Changes

- Workflow session status remains in STATE.json.

## Security Considerations

- No secrets are read or written.

## Migration Risk

- Existing workflow state files remain compatible.

## User-Visible Changes

- Plan submission waits for completed planner output.

## Review Response Boundaries

- Changes stay within workflow orchestration.

## Rollback Notes

- Revert this workflow orchestration change.
`,
    ),
  ])
}

describe("workflow", () => {
  test("creates durable workflow artifacts", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Add password reset flow",
    })

    expect(state.workflow_id).toStartWith("wf_")
    expect(state.state).toBe("drafting_spec")
    expect(state.sessions).toHaveLength(1)
    expect(await Bun.file(path.join(tmp.path, state.artifact_dir, "SPEC.md")).exists()).toBe(true)
    expect(await Bun.file(path.join(tmp.path, state.artifact_dir, "TASKS.md")).exists()).toBe(true)
    expect(await Bun.file(path.join(tmp.path, state.artifact_dir, "IMPACT.md")).exists()).toBe(true)
    expect(await Bun.file(path.join(tmp.path, state.artifact_dir, "STATE.json")).json()).toMatchObject({
      workflow_id: state.workflow_id,
      title: "Add password reset flow",
      request: "Add password reset flow",
      open_github_comments: [],
    })
    const github = await Bun.file(path.join(tmp.path, state.artifact_dir, "GITHUB.md")).text()
    expect(github).toContain("## Open Comments")
    expect(github).toContain("## Review Response Log")
    expect((await $`git branch --show-current`.cwd(tmp.path).quiet().text()).trim()).toBe(state.plan_branch)
  })

  test("non-local start waits for planner completion before auto-submitting plan", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await runWorkflowWithConfig(
      Workflow.Service.use((svc) =>
        svc.start({
          directory: tmp.path,
          title: "Draft before submit",
          localDraft: false,
        }),
      ),
      { workflow: { auto_submit_plan: true, checks: [], github: { enabled: false } } } as Config.Info,
      tmp.path,
    )

    expect(state.state).toBe("drafting_spec")
    expect(state.plan_pull_request.number).toBeUndefined()
    expect(state.sessions).toEqual([expect.objectContaining({ role: "planner", status: "active" })])
  })

  test("validates plan-only files", () => {
    const workflowID = "wf_test"

    expect(WorkflowArtifact.validatePlanOnlyFiles(workflowID, [".opencode/workflows/wf_test/SPEC.md", ".opencode/workflows/wf_test/STATE.json"]).ok).toBe(true)

    expect(WorkflowArtifact.validatePlanOnlyFiles(workflowID, [".opencode/workflows/wf_test/SPEC.md", "packages/opencode/src/index.ts"])).toMatchObject({
      ok: false,
      files: ["packages/opencode/src/index.ts"],
    })
  })

  test("rejects structurally incomplete plan artifacts", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Reject incomplete plan",
      localDraft: true,
    })
    await Bun.write(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "SPEC.md"), "# Missing required workflow sections\n")

    await expect(
      Workflow.submitPlan({
        directory: tmp.path,
        workflowID: state.workflow_id,
        base: "HEAD",
        dryRun: true,
      }),
    ).rejects.toThrow("Invalid workflow artifact structure")
  })

  test("rejects seeded placeholder plan artifacts", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Reject placeholder plan",
      localDraft: true,
    })

    await expect(
      Workflow.submitPlan({
        directory: tmp.path,
        workflowID: state.workflow_id,
        base: "HEAD",
        dryRun: true,
      }),
    ).rejects.toThrow("placeholder-content")
  })

  test("enforces state transitions", () => {
    expect(WorkflowState.canTransition("drafting_spec", "awaiting_plan_review")).toBe(true)
    expect(WorkflowState.canTransition("drafting_spec", "executing")).toBe(false)
    expect(() => WorkflowState.assertTransition("drafting_spec", "executing")).toThrow()
  })

  test("refuses execution and code submission before plan approval", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Gate unapproved implementation",
      localDraft: true,
    })

    await expect(
      Workflow.run({
        directory: tmp.path,
        workflowID: state.workflow_id,
        dryRun: true,
      }),
    ).rejects.toThrow(/approv|plan/i)

    await expect(
      Workflow.submitCode({
        directory: tmp.path,
        workflowID: state.workflow_id,
        base: "HEAD",
        dryRun: true,
      }),
    ).rejects.toThrow(/approv|plan|execut/i)
  })

  test("submit plan stops before GitHub operations when GitHub is disabled", async () => {
    await using tmp = await tmpdir({ git: true })
    const state = await Workflow.start({
      directory: tmp.path,
      title: "Local plan only",
      localDraft: true,
    })

    await expect(
      runWorkflowWithGithubDisabled(
        Workflow.Service.use((svc) =>
          svc.submitPlan({
            directory: tmp.path,
            workflowID: state.workflow_id,
            base: "HEAD",
          }),
        ),
      ),
    ).rejects.toThrow("Workflow GitHub integration is disabled in config.")

    expect(await Workflow.get(tmp.path, state.workflow_id)).toEqual(state)
  })

  test("submit code and sync stop before GitHub operations when GitHub is disabled", async () => {
    await using tmp = await tmpdir({ git: true })
    const state = await Workflow.start({
      directory: tmp.path,
      title: "Local code only",
      localDraft: true,
    })
    const approvedHash = await WorkflowArtifact.hashApprovedArtifacts(tmp.path, state.workflow_id)
    const headCommit = (await $`git rev-parse HEAD`.cwd(tmp.path).quiet().text()).trim()
    const approvedState = {
      ...state,
      state: "plan_approved",
      approved_spec_hash: approvedHash,
      approved_plan_commit: headCommit,
      plan_pull_request: {
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        branch: state.plan_branch,
        head_commit: headCommit,
        review_state: "approved",
        comments: [],
      },
    } satisfies WorkflowState.WorkflowStateFile
    await WorkflowArtifact.writeState(tmp.path, approvedState)

    await expect(
      runWorkflowWithGithubDisabled(
        Workflow.Service.use((svc) =>
          svc.submitCode({
            directory: tmp.path,
            workflowID: state.workflow_id,
            base: "HEAD",
          }),
        ),
      ),
    ).rejects.toThrow("Workflow GitHub integration is disabled in config.")
    expect(await Workflow.get(tmp.path, state.workflow_id)).toEqual(approvedState)

    await expect(
      runWorkflowWithGithubDisabled(
        Workflow.Service.use((svc) =>
          svc.syncGithub({
            directory: tmp.path,
            workflowID: state.workflow_id,
            repo: "acme/repo",
          }),
        ),
      ),
    ).rejects.toThrow("Workflow GitHub integration is disabled in config.")
  })

  test("normalizes GitHub pull request state and comments", () => {
    const pr = WorkflowGithub.pullRequestStateFromGh({
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
      headRefName: "opencode/workflow/wf_test-plan",
      headRefOid: "abc123",
      state: "OPEN",
      reviewDecision: "CHANGES_REQUESTED",
      comments: [
        {
          id: "ic_1",
          body: "Please clarify the impact boundary.",
          author: { login: "reviewer" },
          url: "https://github.com/acme/repo/pull/42#issuecomment-1",
        },
      ],
      reviews: [
        {
          id: "rv_1",
          body: "Approved with note.",
          state: "APPROVED",
          author: { login: "approver" },
          submittedAt: "2026-01-01T00:00:00.000Z",
          url: "https://github.com/acme/repo/pull/42#pullrequestreview-1",
        },
      ],
    })

    expect(pr.review_state).toBe("changes_requested")
    expect(pr.comments).toEqual([
      expect.objectContaining({
        id: "ic_1",
        state: "open",
        source: "issue_comment",
      }),
      expect.objectContaining({
        id: "rv_1",
        state: "open",
        source: "review",
      }),
    ])
    expect(pr.reviewers).toEqual(["approver"])
    expect(pr.approved_by).toBe("approver")
    expect(pr.latest_review_at).toBe("2026-01-01T00:00:00.000Z")
  })

  test("hashes approved artifacts and detects later plan drift", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Hash reviewed plan",
      localDraft: true,
    })
    const approvedHash = await WorkflowArtifact.hashApprovedArtifacts(tmp.path, state.workflow_id)

    await Bun.write(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "GITHUB.md"), "# GitHub\n\nPlan review state: approved\n")

    expect(await WorkflowArtifact.hashApprovedArtifacts(tmp.path, state.workflow_id)).toBe(approvedHash)

    await Bun.write(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "SPEC.md"), "# Hash reviewed plan\n\n## Summary\n\nChanged after approval.\n")

    expect(await WorkflowArtifact.hashApprovedArtifacts(tmp.path, state.workflow_id)).not.toBe(approvedHash)
    await WorkflowArtifact.writeState(tmp.path, {
      ...state,
      state: "plan_approved",
      approved_spec_hash: approvedHash,
      approved_plan_commit: "abc123",
      plan_pull_request: {
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        branch: state.plan_branch,
        head_commit: "abc123",
        review_state: "approved",
        comments: [],
      },
    })
    await expect(
      Workflow.run({
        directory: tmp.path,
        workflowID: state.workflow_id,
        dryRun: true,
      }),
    ).rejects.toThrow(/changed after approval/)
  })

  test("retains merged GitHub comment resolution state", () => {
    expect(
      WorkflowGithub.mergeCommentState(
        [
          {
            id: "ic_1",
            body: "Clarify the task order.",
            state: "addressed",
            source: "issue_comment",
          },
          {
            id: "rv_1",
            body: "This belongs in a follow-up.",
            state: "out_of_scope",
            source: "review",
          },
        ],
        [
          {
            id: "ic_1",
            body: "Clarify the task order.",
            state: "open",
            source: "issue_comment",
          },
          {
            id: "rv_1",
            body: "This belongs in a follow-up.",
            state: "open",
            source: "review",
          },
          {
            id: "ic_2",
            body: "New unresolved concern.",
            state: "open",
            source: "issue_comment",
          },
        ],
      ),
    ).toEqual([expect.objectContaining({ id: "ic_1", state: "addressed" }), expect.objectContaining({ id: "rv_1", state: "out_of_scope" }), expect.objectContaining({ id: "ic_2", state: "open" })])
  })

  test("lists workflow sessions from persisted workflow state", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Track review sessions",
      localDraft: true,
    })
    const reviewState = {
      ...state,
      active_session_id: "ses_review",
      sessions: [
        ...state.sessions.map((session) => ({
          ...session,
          status: "completed" as const,
        })),
        {
          id: "ses_review",
          role: "plan_reviewer" as const,
          status: "active" as const,
          task: "Review plan comment thread",
          created_at: state.created_at,
          updated_at: state.created_at,
          github_comment_url: "https://github.com/acme/repo/pull/1#issuecomment-1",
        },
      ],
    }
    await WorkflowArtifact.writeState(tmp.path, reviewState)

    const saved = await Workflow.get(tmp.path, state.workflow_id)
    const context = await Workflow.sessionContext(tmp.path, state.workflow_id, "ses_review")

    expect(Workflow.sessions(saved)).toEqual([
      expect.objectContaining({ role: "planner", status: "completed" }),
      expect.objectContaining({
        id: "ses_review",
        role: "plan_reviewer",
        status: "active",
        github_comment_url: "https://github.com/acme/repo/pull/1#issuecomment-1",
      }),
    ])
    expect(Workflow.sessions(saved).find((session) => session.id === saved.active_session_id)).toMatchObject({
      task: "Review plan comment thread",
    })
    expect(context.session).toMatchObject({
      id: "ses_review",
      role: "plan_reviewer",
    })
    expect(context.open_comments).toEqual([])
  })

  test("records steering decisions and session updates in artifacts", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Steer active workflow",
      localDraft: true,
    })
    const next = await Workflow.steer({
      directory: tmp.path,
      workflowID: state.workflow_id,
      sessionID: state.active_session_id!,
      instruction: "User asked the planner to narrow the implementation boundary.",
      githubCommentUrl: "https://github.com/acme/repo/pull/1#discussion_r1",
    })

    const saved = await Workflow.get(tmp.path, state.workflow_id)
    const decisions = await Bun.file(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "DECISIONS.md")).text()

    expect(next.current_task).toBe("User asked the planner to narrow the implementation boundary.")
    expect(saved.current_task).toBe("User asked the planner to narrow the implementation boundary.")
    expect(Workflow.sessions(saved)).toEqual([
      expect.objectContaining({
        task: "User asked the planner to narrow the implementation boundary.",
        github_comment_url: "https://github.com/acme/repo/pull/1#discussion_r1",
      }),
    ])
    expect(decisions).toContain("workflow.session.steered")
    expect(decisions).toContain("User asked the planner to narrow the implementation boundary.")
  })

  test("pauses and resumes workflows to the correct review state", async () => {
    await using tmp = await tmpdir({ git: true })

    const draft = await Workflow.start({
      directory: tmp.path,
      title: "Pause draft workflow",
      localDraft: true,
    })

    expect((await Workflow.pause(tmp.path, draft.workflow_id)).state).toBe("paused")
    expect((await Workflow.resume(tmp.path, draft.workflow_id)).state).toBe("drafting_spec")

    const awaitingReview = await Workflow.get(tmp.path, draft.workflow_id)
    await WorkflowArtifact.writeState(tmp.path, {
      ...awaitingReview,
      state: "plan_approved",
      plan_pull_request: {
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        branch: awaitingReview.plan_branch,
        head_commit: "abc123",
        review_state: "approved",
        comments: [],
      },
    })

    expect((await Workflow.pause(tmp.path, draft.workflow_id)).state).toBe("paused")
    expect((await Workflow.resume(tmp.path, draft.workflow_id)).state).toBe("plan_approved")
  })

  test("processes amendment approval without requiring a synthetic review comment", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Approve amendment",
      localDraft: true,
    })
    await Bun.write(
      WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "AMENDMENT.md"),
      `# Amendment

## Reason

Scope drift: src/new.ts

## Approval Status

pending
`,
    )
    await WorkflowArtifact.writeState(tmp.path, {
      ...state,
      state: "needs_amendment",
    })

    const next = await Workflow.processAmendment({
      directory: tmp.path,
      workflowID: state.workflow_id,
      approve: true,
      reason: "Approved for this workflow.",
    })
    const amendment = await Bun.file(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "AMENDMENT.md")).text()
    const decisions = await Bun.file(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "DECISIONS.md")).text()

    expect(next.state).toBe("awaiting_plan_review")
    expect(amendment).toContain("approved")
    expect(amendment).toContain("## Resolved")
    expect(decisions).toContain("workflow.amendment.approved")
    expect(decisions).toContain("Scope drift: src/new.ts")
  })

  test("validates scope drift outside workflow artifacts", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Keep implementation scoped",
      localDraft: true,
    })
    await writeReviewedPlanArtifacts(tmp.path, state.workflow_id)
    await mkdir(path.join(tmp.path, "packages", "opencode", "src"), { recursive: true })
    await Bun.write(path.join(tmp.path, "packages", "opencode", "src", "index.ts"), "export const drift = true\n")

    const validation = await Workflow.validatePlan(tmp.path, state.workflow_id, "HEAD")

    expect(validation).toMatchObject({
      ok: false,
      files: ["packages/opencode/src/index.ts"],
    })
    await expect(
      Workflow.submitPlan({
        directory: tmp.path,
        workflowID: state.workflow_id,
        base: "HEAD",
        dryRun: true,
      }),
    ).rejects.toThrow("Plan branch contains non-workflow changes: packages/opencode/src/index.ts")
    expect((await Workflow.get(tmp.path, state.workflow_id)).last_validation).toMatchObject({
      ok: false,
      summary: "Plan branch contains non-workflow changes: packages/opencode/src/index.ts",
    })
  })

  test("sync invalidates approved hash when approved plan artifacts change", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Invalidate changed approved plan",
      localDraft: true,
    })
    await Bun.write(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "IMPACT.md"), "# Impact\n\n## Allowed Paths\n\n- src/**\n")
    const approvedHash = await WorkflowArtifact.hashApprovedArtifacts(tmp.path, state.workflow_id)
    await WorkflowArtifact.writeState(tmp.path, {
      ...state,
      state: "plan_approved",
      approved_spec_hash: approvedHash,
      approved_plan_commit: "abc123",
      plan_pull_request: {
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        branch: state.plan_branch,
        head_commit: "abc123",
        review_state: "approved",
        comments: [],
      },
    })
    await Bun.write(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "SPEC.md"), "# Changed\n\n## Summary\n\nChanged after approval.\n")

    const next = await Workflow.syncGithub({
      directory: tmp.path,
      workflowID: state.workflow_id,
    })
    const decisions = await Bun.file(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "DECISIONS.md")).text()

    expect(next.state).toBe("needs_amendment")
    expect(next.approved_spec_hash).toBeUndefined()
    expect(next.approved_plan_commit).toBeUndefined()
    expect(next.plan_pull_request.comments).toContainEqual(
      expect.objectContaining({
        id: "local-approved-plan-drift",
        state: "open",
      }),
    )
    expect(decisions).toContain("workflow.approved_plan.invalidated")
  })

  test("sync does not recreate plan approval from stale review after amendment approval", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Require reapproval after amendment",
      localDraft: true,
    })
    await Bun.write(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "IMPACT.md"), "# Impact\n\n## Allowed Paths\n\n- src/**\n")
    const approvedHash = await WorkflowArtifact.hashApprovedArtifacts(tmp.path, state.workflow_id)
    await Bun.write(
      WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "AMENDMENT.md"),
      `# Amendment

## Reason

Scope drift: src/new.ts

## Approval Status

pending
`,
    )
    await WorkflowArtifact.writeState(tmp.path, {
      ...state,
      state: "needs_amendment",
      approved_spec_hash: approvedHash,
      approved_plan_commit: "abc123",
      plan_pull_request: {
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        branch: state.plan_branch,
        head_commit: "abc123",
        review_state: "approved",
        approved_at: "1970-01-01T00:00:00.000Z",
        comments: [],
      },
    })

    await Effect.runPromise(WorkflowApproval.Service.use((svc) => svc.approveAmendment(tmp.path, state.workflow_id)).pipe(Effect.provide(WorkflowApproval.defaultLayer)))
    const amended = await WorkflowArtifact.readState(tmp.path, state.workflow_id)
    const stale = await runWorkflowWithGithub(
      Workflow.Service.use((svc) =>
        svc.syncGithub({
          directory: tmp.path,
          workflowID: state.workflow_id,
          repo: "acme/repo",
        }),
      ),
      mockGithub({
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        branch: state.plan_branch,
        head_commit: "abc123",
        review_state: "approved",
        approved_at: "1970-01-01T00:00:00.000Z",
        comments: [],
      }),
      tmp.path,
    )

    expect(amended.plan_reapproval_required_at).toBeTruthy()
    expect(stale.state).toBe("awaiting_plan_review")
    expect(stale.approved_spec_hash).toBeUndefined()
    expect(stale.approved_plan_commit).toBeUndefined()
    expect(stale.plan_approval).toBeUndefined()

    const reapproved = await runWorkflowWithGithub(
      Workflow.Service.use((svc) =>
        svc.syncGithub({
          directory: tmp.path,
          workflowID: state.workflow_id,
          repo: "acme/repo",
        }),
      ),
      mockGithub({
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        branch: state.plan_branch,
        head_commit: "def456",
        review_state: "approved",
        approved_at: new Date(new Date(amended.plan_reapproval_required_at ?? "").getTime() + 1000).toISOString(),
        comments: [],
      }),
      tmp.path,
    )

    expect(reapproved.state).toBe("plan_approved")
    expect(reapproved.approved_spec_hash).toBe(await WorkflowArtifact.hashApprovedArtifacts(tmp.path, state.workflow_id))
    expect(reapproved.approved_plan_commit).toBe("def456")
    expect(reapproved.plan_approval?.approved_plan_commit).toBe("def456")
    expect(reapproved.plan_reapproval_required_at).toBeUndefined()
  })

  test("code approval does not complete workflow without validation evidence", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Require validation before complete",
      localDraft: true,
    })
    await Bun.write(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "IMPACT.md"), "# Impact\n\n## Allowed Paths\n\n- src/**\n")
    const approvedHash = await WorkflowArtifact.hashApprovedArtifacts(tmp.path, state.workflow_id)
    await WorkflowArtifact.writeState(tmp.path, {
      ...state,
      state: "awaiting_code_review",
      approved_spec_hash: approvedHash,
      approved_plan_commit: "abc123",
      plan_pull_request: {
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        branch: state.plan_branch,
        head_commit: "abc123",
        review_state: "approved",
        comments: [],
      },
      code_pull_request: {
        number: 8,
        url: "https://github.com/acme/repo/pull/8",
        branch: state.code_branch,
        head_commit: "def456",
        review_state: "approved",
        comments: [],
      },
    })

    const next = await Workflow.syncGithub({
      directory: tmp.path,
      workflowID: state.workflow_id,
    })

    expect(next.state).toBe("awaiting_code_review")
    expect(next.user_input_needed).toContain("validation evidence")
  })

  test("scope-expanding code comments require amendment before action", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Guard review scope",
      localDraft: true,
    })
    await Bun.write(
      WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "SPEC.md"),
      "# Guard review scope\n\n## Summary\n\nUpdate API implementation.\n\n## Requirements\n\n- Update API implementation\n\n## Out of Scope\n\n- Documentation site\n",
    )
    await Bun.write(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "IMPACT.md"), "# Impact\n\n## Allowed Paths\n\n- src/**\n\n## Forbidden Paths\n\n- docs/**\n")
    const approvedHash = await WorkflowArtifact.hashApprovedArtifacts(tmp.path, state.workflow_id)
    await WorkflowArtifact.writeState(tmp.path, {
      ...state,
      state: "awaiting_code_review",
      approved_spec_hash: approvedHash,
      approved_plan_commit: "abc123",
      plan_pull_request: {
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        branch: state.plan_branch,
        head_commit: "abc123",
        review_state: "approved",
        comments: [],
      },
      code_pull_request: {
        number: 8,
        url: "https://github.com/acme/repo/pull/8",
        branch: state.code_branch,
        head_commit: "def456",
        review_state: "changes_requested",
        comments: [],
      },
    })

    const next = await Workflow.recordComment({
      directory: tmp.path,
      workflowID: state.workflow_id,
      pullRequest: "code",
      comment: {
        id: "c_scope",
        url: "https://github.com/acme/repo/pull/8#discussion_r1",
        body: "Please add a documentation site page for this feature.",
        path: "docs/feature.md",
      },
    })
    const decisions = await Bun.file(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "DECISIONS.md")).text()

    expect(next.state).toBe("needs_amendment")
    expect(next.code_pull_request.comments).toContainEqual(
      expect.objectContaining({
        id: "c_scope",
        state: "out_of_scope",
      }),
    )
    expect(decisions).toContain("workflow.comment.requires_amendment")
    expect(await Bun.file(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "AMENDMENT.md")).text()).toContain("Path docs/feature.md matches forbidden path docs/**")
  })

  test("post-approval plan comments also pass through the scope guard", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Guard approved plan comments",
      localDraft: true,
    })
    await Bun.write(
      WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "SPEC.md"),
      "# Guard approved plan comments\n\n## Summary\n\nUpdate API implementation.\n\n## Requirements\n\n- Update API implementation\n\n## Out of Scope\n\n- Documentation site\n",
    )
    await Bun.write(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "IMPACT.md"), "# Impact\n\n## Allowed Paths\n\n- src/**\n\n## Forbidden Paths\n\n- docs/**\n")
    const approvedHash = await WorkflowArtifact.hashApprovedArtifacts(tmp.path, state.workflow_id)
    await WorkflowArtifact.writeState(tmp.path, {
      ...state,
      state: "plan_approved",
      approved_spec_hash: approvedHash,
      approved_plan_commit: "abc123",
      plan_pull_request: {
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        branch: state.plan_branch,
        head_commit: "abc123",
        review_state: "approved",
        comments: [],
      },
    })

    const next = await Workflow.recordComment({
      directory: tmp.path,
      workflowID: state.workflow_id,
      pullRequest: "plan",
      comment: {
        id: "plan_scope",
        url: "https://github.com/acme/repo/pull/7#discussion_r1",
        body: "Please add a documentation site page for this feature.",
        path: "docs/feature.md",
      },
    })

    expect(next.state).toBe("needs_amendment")
    expect(next.plan_pull_request.comments).toContainEqual(
      expect.objectContaining({
        id: "plan_scope",
        state: "out_of_scope",
      }),
    )
  })

  test("synced GitHub code comments pass through the scope guard", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Guard synced review scope",
      localDraft: true,
    })
    await Bun.write(
      WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "SPEC.md"),
      "# Guard synced review scope\n\n## Summary\n\nUpdate API implementation.\n\n## Requirements\n\n- Update API implementation\n\n## Out of Scope\n\n- Documentation site\n",
    )
    await Bun.write(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "IMPACT.md"), "# Impact\n\n## Allowed Paths\n\n- src/**\n\n## Forbidden Paths\n\n- docs/**\n")
    const approvedHash = await WorkflowArtifact.hashApprovedArtifacts(tmp.path, state.workflow_id)
    await WorkflowArtifact.writeState(tmp.path, {
      ...state,
      state: "awaiting_code_review",
      approved_spec_hash: approvedHash,
      approved_plan_commit: "abc123",
      plan_pull_request: {
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        branch: state.plan_branch,
        head_commit: "abc123",
        review_state: "approved",
        comments: [],
      },
      code_pull_request: {
        number: 8,
        url: "https://github.com/acme/repo/pull/8",
        branch: state.code_branch,
        head_commit: "def456",
        review_state: "changes_requested",
        comments: [],
      },
    })

    const githubMockObj = mockGithub({
      number: 8,
      url: "https://github.com/acme/repo/pull/8",
      branch: state.code_branch,
      head_commit: "def456",
      review_state: "changes_requested",
      comments: [
        {
          id: "99",
          url: "https://github.com/acme/repo/pull/8#discussion_r99",
          body: "Please add a documentation site page for this feature.",
          path: "docs/feature.md",
          state: "open",
          source: "review_comment",
        },
      ],
    })
    const githubLayer = Layer.succeed(WorkflowGithub.Service, WorkflowGithub.Service.of(githubMockObj))
    const workflowLayer = Workflow.layer.pipe(
      Layer.provide(githubLayer),
      Layer.provide(WorkflowApproval.defaultLayer),
      Layer.provide(WorkflowScope.defaultLayer),
      Layer.provide(WorkflowArtifact.defaultLayer),
      Layer.provide(Bus.layer),
    )
    const next = await Effect.runPromise(
      provideInstance(tmp.path)(
        Workflow.Service.use((svc) =>
          svc.syncGithub({
            directory: tmp.path,
            workflowID: state.workflow_id,
            repo: "acme/repo",
          }),
        ),
      ).pipe(Effect.provide(workflowLayer)),
    )

    expect(next.state).toBe("needs_amendment")
    expect(next.code_pull_request.comments).toContainEqual(
      expect.objectContaining({
        id: "99",
        source: "review_comment",
        path: "docs/feature.md",
        state: "out_of_scope",
      }),
    )
    expect(await Bun.file(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "AMENDMENT.md")).text()).toContain("Path docs/feature.md matches forbidden path docs/**")
  })

  test("revise plan records review feedback in plan artifacts", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Revise reviewed plan",
      localDraft: true,
    })
    await WorkflowArtifact.writeState(tmp.path, {
      ...state,
      state: "awaiting_plan_review",
      plan_pull_request: {
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        branch: state.plan_branch,
        head_commit: "abc123",
        review_state: "changes_requested",
        comments: [
          {
            id: "plan_feedback",
            url: "https://github.com/acme/repo/pull/7#issuecomment-1",
            body: "Clarify rollback plan.",
            state: "open",
            source: "issue_comment",
          },
        ],
      },
    })

    const next = await Workflow.revisePlan({
      directory: tmp.path,
      workflowID: state.workflow_id,
    })
    const spec = await WorkflowArtifact.readArtifact(tmp.path, state.workflow_id, "SPEC.md")
    const tasks = await WorkflowArtifact.readArtifact(tmp.path, state.workflow_id, "TASKS.md")
    const impact = await WorkflowArtifact.readArtifact(tmp.path, state.workflow_id, "IMPACT.md")

    expect(next.state).toBe("addressing_plan_comments")
    expect(next.plan_pull_request.comments).toContainEqual(
      expect.objectContaining({
        id: "plan_feedback",
        state: "open",
      }),
    )
    expect(spec).toContain("Clarify rollback plan.")
    expect(tasks).toContain("Review Response Tasks")
    expect(impact).toContain("Review Response Boundaries")
    expect(next.sessions).toContainEqual(expect.objectContaining({ role: "plan_reviewer" }))
    expect(await WorkflowArtifact.readArtifact(tmp.path, state.workflow_id, "DECISIONS.md")).toContain("Session:")
  })

  test("revise plan runs reviewer session, pushes plan branch, and replies with evidence", async () => {
    await using tmp = await tmpdir({ git: true })

    await $`git branch -M dev`.cwd(tmp.path).quiet()
    await $`git init --bare remote.git`.cwd(tmp.path).quiet()
    await $`git remote add origin ${path.join(tmp.path, "remote.git")}`.cwd(tmp.path).quiet()
    await $`git push -u origin dev`.cwd(tmp.path).quiet()

    await mkdir(path.join(tmp.path, "bin"))
    await Bun.write(path.join(tmp.path, ".git", "info", "exclude"), "bin/\nremote.git/\n")
    await Bun.write(
      path.join(tmp.path, "bin", "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "repo view" ]]; then
  echo "acme/repo"
  exit 0
fi
if [[ "$1 $2" == "pr view" ]]; then
  sha="$(git rev-parse HEAD)"
  printf '{"number":7,"url":"https://github.com/acme/repo/pull/7","headRefName":"%s","headRefOid":"%s","reviewDecision":"REVIEW_REQUIRED","state":"OPEN"}\\n' "$3" "$sha"
  exit 0
fi
if [[ "$1 $2" == "pr edit" || "$1 $2" == "pr create" ]]; then
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`,
    )
    await $`chmod +x ${path.join(tmp.path, "bin", "gh")}`.quiet()

    const previousPath = process.env.PATH
    process.env.PATH = `${path.join(tmp.path, "bin")}${path.delimiter}${previousPath ?? ""}`
    try {
      const state = await Workflow.start({
        directory: tmp.path,
        title: "Autonomous plan revision",
        localDraft: true,
      })
      await writeReviewedPlanArtifacts(tmp.path, state.workflow_id)
      const comment: WorkflowState.ReviewComment = {
        id: "123",
        url: "https://github.com/acme/repo/pull/7#issuecomment-123",
        body: "Clarify rollback plan.",
        state: "open",
        source: "issue_comment",
      }
      await WorkflowArtifact.writeState(tmp.path, {
        ...state,
        state: "awaiting_plan_review",
        plan_pull_request: {
          number: 7,
          url: "https://github.com/acme/repo/pull/7",
          branch: state.plan_branch,
          head_commit: "abc123",
          review_state: "changes_requested",
          comments: [comment],
        },
      })

      const prompts: string[] = []
      const replies: string[] = []
      const next = await Effect.runPromise(
        provideInstance(tmp.path)(
          Workflow.Service.use((svc) =>
            svc.revisePlan({
              directory: tmp.path,
              workflowID: state.workflow_id,
            }),
          ),
        ).pipe(
          Effect.provide(
            Workflow.layer.pipe(
              Layer.provide(
                Layer.succeed(
                  WorkflowGithub.Service,
                  WorkflowGithub.Service.of({
                    ...mockGithub({
                      number: 7,
                      url: "https://github.com/acme/repo/pull/7",
                      branch: state.plan_branch,
                      head_commit: "def456",
                      review_state: "pending",
                      comments: [comment],
                    }),
                    addComment: (_repo, _pr, body) =>
                      Effect.sync(() => {
                        replies.push(body)
                      }),
                  }),
                ),
              ),
              Layer.provide(WorkflowApproval.defaultLayer),
              Layer.provide(WorkflowScope.defaultLayer),
              Layer.provide(WorkflowArtifact.defaultLayer),
              Layer.provide(Bus.layer),
            ),
          ),
          Effect.provideService(Session.Service, Session.Service.of(mockWfSession)),
          Effect.provideService(
            SessionPrompt.Service,
            SessionPrompt.Service.of({
              ...mockWfSessionPrompt,
              prompt: (input) =>
                Effect.sync(() => {
                  prompts.push(input.parts.map((part) => ("text" in part ? part.text : "")).join("\n"))
                  return mockWfPromptResponse
                }),
            }),
          ),
          Effect.provideService(Config.Service, {
            ...mockWfConfig,
            get: () => Effect.succeed({ workflow: { checks: [] } } as Config.Info),
          }),
        ),
      )

      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain("## Open Plan Comments")
      expect(prompts[0]).toContain("Clarify rollback plan.")
      expect(replies).toHaveLength(1)
      expect(replies[0]).toContain("Addressed in the revised plan artifacts")
      expect(replies[0]).toContain("Evidence:")
      expect(next.state).toBe("awaiting_plan_review")
      expect(next.plan_pull_request.comments).toContainEqual(expect.objectContaining({ id: "123", state: "addressed" }))
      expect(await $`git ls-remote --heads origin ${state.plan_branch}`.cwd(tmp.path).quiet().text()).toContain(state.plan_branch)
    } finally {
      process.env.PATH = previousPath
    }
  })

  test("in-scope review comments become response tasks with audit evidence", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Queue code review response",
      localDraft: true,
    })
    await WorkflowArtifact.writeArtifact(
      tmp.path,
      state.workflow_id,
      "IMPACT.md",
      `# Impact

## Allowed Paths

- packages/opencode/src/workflow/review.ts

## Expected New Files

- None

## Forbidden Paths

- .env

## Dependency Changes

- None

## Data Model Changes

- None

## Security Considerations

- No secret handling changes.

## Migration Risk

- None

## User-Visible Changes

- None

## Review Response Boundaries

Only address workflow review handling.

## Rollback Notes

Revert the workflow review change.
`,
    )
    const comment = {
      id: "12345",
      url: "https://github.com/acme/repo/pull/8#discussion_r12345",
      author: "reviewer",
      body: "Please update the implementation in `packages/opencode/src/workflow/review.ts`.",
      state: "open" as const,
      source: "review_comment" as const,
      path: "packages/opencode/src/workflow/review.ts",
    }
    await WorkflowArtifact.writeState(tmp.path, {
      ...state,
      state: "awaiting_code_review",
      code_pull_request: {
        number: 8,
        url: "https://github.com/acme/repo/pull/8",
        branch: state.code_branch,
        head_commit: "def456",
        review_state: "changes_requested",
        comments: [comment],
      },
    })

    const task = await Effect.runPromise(
      Effect.gen(function* () {
        const review = yield* WorkflowReview.Service
        return yield* review.createResponseTask(tmp.path, state.workflow_id, comment)
      }).pipe(
        Effect.provide(
          WorkflowReview.layer.pipe(
            Layer.provide(
              Workflow.layer.pipe(
                Layer.provide(Layer.succeed(WorkflowGithub.Service, WorkflowGithub.Service.of(disabledGithub))),
                Layer.provide(WorkflowApproval.defaultLayer),
                Layer.provide(WorkflowScope.defaultLayer),
                Layer.provide(WorkflowArtifact.defaultLayer),
                Layer.provide(Layer.succeed(Bus.Service, testBus)),
              ),
            ),
            Layer.provide(Layer.succeed(WorkflowGithub.Service, WorkflowGithub.Service.of(disabledGithub))),
            Layer.provide(Layer.succeed(Bus.Service, testBus)),
          ),
        ),
      ),
    )
    const saved = await Workflow.get(tmp.path, state.workflow_id)
    const tasks = await WorkflowArtifact.readArtifact(tmp.path, state.workflow_id, "TASKS.md")
    const github = await WorkflowArtifact.readArtifact(tmp.path, state.workflow_id, "GITHUB.md")
    const decisions = await WorkflowArtifact.readArtifact(tmp.path, state.workflow_id, "DECISIONS.md")

    expect(task).toContain("review_12345")
    expect(tasks).toContain("review_12345")
    expect(tasks).toContain("github: https://github.com/acme/repo/pull/8#discussion_r12345")
    expect(saved.sessions).toContainEqual(expect.objectContaining({ role: "code_reviewer", github_comment_url: comment.url }))
    expect(saved.open_github_comments).toContainEqual(expect.objectContaining({ id: "12345" }))
    expect(github).toContain("## Open Comments")
    expect(github).toContain("code 12345 [open]")
    expect(github).toContain("## Review Response Log")
    expect(decisions).toContain("workflow.review_response_task.created")
    expect(decisions).toContain("Workflow:")
    expect(decisions).toContain("Session:")
  })

  test("sync github queues response tasks through the default review subscriber", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Sync review feedback",
      localDraft: true,
    })
    await WorkflowArtifact.writeArtifact(tmp.path, state.workflow_id, "SPEC.md", "# Sync review feedback\n\n## Summary\n\nUpdate workflow review handling.\n")
    await WorkflowArtifact.writeArtifact(tmp.path, state.workflow_id, "TASKS.md", "# Tasks\n\n- [ ] Update workflow review handling\n")
    await WorkflowArtifact.writeArtifact(
      tmp.path,
      state.workflow_id,
      "IMPACT.md",
      `# Impact

## Allowed Paths

- packages/opencode/src/workflow/review.ts

## Expected New Files

- None

## Forbidden Paths

- .env

## Dependency Changes

- None

## Data Model Changes

- None

## Security Considerations

- No secret handling changes.

## Migration Risk

- None

## User-Visible Changes

- None

## Review Response Boundaries

Only address workflow review handling.

## Rollback Notes

Revert the workflow review change.
`,
    )
    const comment = {
      id: "67890",
      url: "https://github.com/acme/repo/pull/8#discussion_r67890",
      author: "reviewer",
      body: "Please update workflow review handling in packages/opencode/src/workflow/review.ts.",
      state: "open" as const,
      source: "review_comment" as const,
      path: "packages/opencode/src/workflow/review.ts",
    }
    await WorkflowArtifact.writeState(tmp.path, {
      ...state,
      state: "awaiting_plan_review",
      plan_pull_request: {
        number: 8,
        url: "https://github.com/acme/repo/pull/8",
        branch: state.plan_branch,
        head_commit: "def456",
        review_state: "pending",
        comments: [],
      },
      code_pull_request: WorkflowState.emptyPullRequest(),
    })
    const githubLayer = Layer.succeed(
      WorkflowGithub.Service,
      WorkflowGithub.Service.of(
        mockGithub({
          number: 8,
          url: "https://github.com/acme/repo/pull/8",
          branch: state.plan_branch,
          head_commit: "def456",
          review_state: "changes_requested",
          comments: [comment],
        }),
      ),
    )
    const workflowRuntimeLayer = Workflow.layer.pipe(
      Layer.provide(githubLayer),
      Layer.provide(WorkflowApproval.defaultLayer),
      Layer.provide(WorkflowScope.defaultLayer),
      Layer.provide(WorkflowArtifact.defaultLayer),
    )
    const reviewRuntimeLayer = WorkflowReview.layer.pipe(Layer.provide(workflowRuntimeLayer), Layer.provide(githubLayer))
    const workflowWithReviewLayer = Layer.effect(
      Workflow.Service,
      Effect.gen(function* () {
        const workflow = yield* Workflow.Service
        yield* WorkflowReview.Service
        return workflow
      }),
    ).pipe(Layer.provide(Layer.mergeAll(workflowRuntimeLayer, reviewRuntimeLayer)))

    const saved = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        yield* Effect.sleep("10 millis")
        yield* svc.syncGithub({
          directory: tmp.path,
          workflowID: state.workflow_id,
          repo: "acme/repo",
        })
        yield* Effect.sleep("500 millis")
        return yield* svc.get(tmp.path, state.workflow_id)
      }).pipe(Effect.scoped, Effect.provide(workflowWithReviewLayer.pipe(Layer.provide(Bus.layer))), provideInstance(tmp.path)),
    )
    const tasks = await WorkflowArtifact.readArtifact(tmp.path, state.workflow_id, "TASKS.md")
    const decisions = await WorkflowArtifact.readArtifact(tmp.path, state.workflow_id, "DECISIONS.md")

    expect(saved.plan_pull_request.comments).toContainEqual(expect.objectContaining({ id: "67890", state: "open" }))
    expect(saved.sessions).toContainEqual(expect.objectContaining({ role: "plan_reviewer", github_comment_url: comment.url }))
    expect(tasks).toContain("review_67890")
    expect(decisions).toContain("workflow.review_response_task.created")
  })

  test("workflow run invokes the executor loop after preparing the code branch", async () => {
    await using tmp = await tmpdir({ git: true })
    await $`git remote add origin .`.cwd(tmp.path)

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Run approved workflow",
      localDraft: true,
    })
    await Bun.write(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "TASKS.md"), "# Tasks\n\n- [ ] Complete approved implementation work\n")
    const approvedHash = await WorkflowArtifact.hashApprovedArtifacts(tmp.path, state.workflow_id)
    const headCommit = (await $`git rev-parse HEAD`.cwd(tmp.path).quiet().text()).trim()
    await WorkflowArtifact.writeState(tmp.path, {
      ...state,
      state: "plan_approved",
      approved_spec_hash: approvedHash,
      approved_plan_commit: headCommit,
      plan_pull_request: {
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        branch: state.plan_branch,
        head_commit: headCommit,
        review_state: "approved",
        comments: [],
      },
    })

    const next = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Workflow.Service
        return yield* svc.run({ directory: tmp.path, workflowID: state.workflow_id })
      }).pipe(
        Effect.provide(
          Workflow.layer.pipe(
            Layer.provide(WorkflowExecutor.defaultLayer),
            Layer.provide(
              Layer.succeed(
                WorkflowGithub.Service,
                WorkflowGithub.Service.of(
                  mockGithub({
                    review_state: "approved",
                    comments: [],
                  }),
                ),
              ),
            ),
            Layer.provide(WorkflowApproval.defaultLayer),
            Layer.provide(WorkflowScope.defaultLayer),
            Layer.provide(WorkflowArtifact.defaultLayer),
            Layer.provide(Bus.layer),
          ),
        ),
        Effect.provideService(Session.Service, mockWfSession),
        Effect.provideService(SessionPrompt.Service, mockWfSessionPrompt),
        Effect.provideService(Config.Service, mockWfConfig),
        provideInstance(tmp.path),
      ),
    )

    expect(next.state).toBe("awaiting_code_review")
    expect(next.completed_tasks).toEqual(["task_0"])
    expect(next.sessions).toContainEqual(
      expect.objectContaining({
        role: "executor",
      }),
    )
  })
})
