import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { mkdir } from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { WorkflowArtifact } from "../../src/workflow/artifact"
import { WorkflowGithub } from "../../src/workflow/github"
import { WorkflowState } from "../../src/workflow/state"
import { Workflow } from "../../src/workflow/workflow"

describe("workflow", () => {
  test("creates durable workflow artifacts", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Add password reset flow",
      localDraft: true,
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
    })
    expect((await $`git branch --show-current`.cwd(tmp.path).quiet().text()).trim()).toBe(state.plan_branch)
  })

  test("validates plan-only files", () => {
    const workflowID = "wf_test"

    expect(
      WorkflowArtifact.validatePlanOnlyFiles(workflowID, [
        ".opencode/workflows/wf_test/SPEC.md",
        ".opencode/workflows/wf_test/STATE.json",
      ]).ok,
    ).toBe(true)

    expect(
      WorkflowArtifact.validatePlanOnlyFiles(workflowID, [
        ".opencode/workflows/wf_test/SPEC.md",
        "packages/opencode/src/index.ts",
      ]),
    ).toMatchObject({
      ok: false,
      files: ["packages/opencode/src/index.ts"],
    })
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
          body: "",
          state: "COMMENTED",
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
    ])
  })

  test("hashes approved artifacts and detects later plan drift", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Hash reviewed plan",
      localDraft: true,
    })
    const approvedHash = await WorkflowArtifact.hashApprovedArtifacts(tmp.path, state.workflow_id)

    await Bun.write(
      WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "GITHUB.md"),
      "# GitHub\n\nPlan review state: approved\n",
    )

    expect(await WorkflowArtifact.hashApprovedArtifacts(tmp.path, state.workflow_id)).toBe(approvedHash)

    await Bun.write(
      WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "SPEC.md"),
      "# Hash reviewed plan\n\n## Summary\n\nChanged after approval.\n",
    )

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
    ).toEqual([
      expect.objectContaining({ id: "ic_1", state: "addressed" }),
      expect.objectContaining({ id: "rv_1", state: "out_of_scope" }),
      expect.objectContaining({ id: "ic_2", state: "open" }),
    ])
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
    expect((await Workflow.resume(tmp.path, draft.workflow_id)).state).toBe("awaiting_plan_review")

    const awaitingReview = await Workflow.get(tmp.path, draft.workflow_id)
    await WorkflowArtifact.writeState(tmp.path, {
      ...awaitingReview,
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

    expect(next.state).toBe("executing")
    expect(amendment).toContain("approved")
    expect(amendment).toContain("## Resolved")
    expect(decisions).toContain("workflow.amendment.approved")
    expect(decisions).toContain("Approved for this workflow.")
  })

  test("validates scope drift outside workflow artifacts", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Keep implementation scoped",
      localDraft: true,
    })
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
    await Bun.write(
      WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "IMPACT.md"),
      "# Impact\n\n## Allowed Paths\n\n- src/**\n",
    )
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
    await Bun.write(
      WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "SPEC.md"),
      "# Changed\n\n## Summary\n\nChanged after approval.\n",
    )

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

  test("code approval does not complete workflow without validation evidence", async () => {
    await using tmp = await tmpdir({ git: true })

    const state = await Workflow.start({
      directory: tmp.path,
      title: "Require validation before complete",
      localDraft: true,
    })
    await Bun.write(
      WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "IMPACT.md"),
      "# Impact\n\n## Allowed Paths\n\n- src/**\n",
    )
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
    await Bun.write(
      WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "IMPACT.md"),
      "# Impact\n\n## Allowed Paths\n\n- src/**\n\n## Forbidden Paths\n\n- docs/**\n",
    )
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
    expect(await Bun.file(WorkflowArtifact.artifactPath(tmp.path, state.workflow_id, "AMENDMENT.md")).text()).toContain(
      "Path docs/feature.md matches forbidden path docs/**",
    )
  })
})
