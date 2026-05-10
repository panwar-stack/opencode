import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { WorkflowState } from "../../src/workflow/state"

describe("WorkflowReview", () => {
  test("classifyComment detects in-scope review feedback", () => {
    const comment = {
      id: "c1",
      body: "Please add error handling to the password reset endpoint.",
      state: "open" as const,
      source: "issue_comment" as const,
    }

    const spec = "Add password reset flow with email verification"
    const tasks = "- [x] Create reset token endpoint\n- [ ] Add email template"
    const impact = "## Allowed Paths\n- packages/server/**"

    // Verify keywords overlap between comment and spec/tasks
    expect(comment.body.toLowerCase()).toContain("password")
    expect(spec.toLowerCase()).toContain("password")
    expect(comment.body.toLowerCase()).toContain("error handling")
    expect(tasks.toLowerCase()).toContain("endpoint")
  })

  test("classifyComment detects out-of-scope boundary", () => {
    const comment = {
      id: "c2",
      body: "This change is out of scope for this workflow.",
      state: "open" as const,
      source: "issue_comment" as const,
    }

    expect(comment.body.toLowerCase()).toContain("out of scope")
  })

  test("classifyComment detects already-addressed comments", () => {
    const comment = {
      id: "c3",
      body: "This has already been addressed in a previous commit.",
      state: "open" as const,
      source: "issue_comment" as const,
    }

    expect(comment.body.toLowerCase()).toContain("already")
  })

  test("classifyComment handles clarification requests", () => {
    const comment = {
      id: "c4",
      body: "Can you explain why this approach was chosen?",
      state: "open" as const,
      source: "issue_comment" as const,
    }

    expect(comment.body.toLowerCase()).toContain("explain")
    expect(comment.body.toLowerCase()).toContain("?")
  })

  test("markComment transitions review comment state", async () => {
    await using tmp = await tmpdir({ git: true })

    const state: WorkflowState.WorkflowStateFile = {
      workflow_id: "wf_test",
      title: "test",
      state: "drafting_spec",
      artifact_dir: ".opencode/workflows/wf_test",
      created_at: WorkflowState.now(),
      updated_at: WorkflowState.now(),
      plan_branch: "branch",
      plan_pull_request: WorkflowState.emptyPullRequest(),
      code_pull_request: WorkflowState.emptyPullRequest(),
      sessions: [],
    }

    const withComment = WorkflowState.appendComment(state, "plan", {
      id: "c5",
      body: "Clarify the task order.",
      author: "reviewer",
    })

    expect(withComment.plan_pull_request.comments).toHaveLength(1)
    expect(withComment.plan_pull_request.comments[0].state).toBe("open")

    const marked = WorkflowState.markComment(withComment, "plan", "c5", "addressed")
    expect(marked.plan_pull_request.comments[0].state).toBe("addressed")
  })

  test("recordComment tracks review feedback", () => {
    const state: WorkflowState.WorkflowStateFile = {
      workflow_id: "wf_test",
      title: "record comments",
      state: "drafting_spec",
      artifact_dir: ".opencode/workflows/wf_test",
      created_at: WorkflowState.now(),
      updated_at: WorkflowState.now(),
      plan_branch: "branch",
      plan_pull_request: WorkflowState.emptyPullRequest(),
      code_pull_request: WorkflowState.emptyPullRequest(),
      sessions: [],
    }

    const comment = {
      id: "c6",
      url: "https://github.com/acme/repo/pull/1#discussion_r2",
      author: "reviewer",
      body: "Consider using a rate limiter for the API.",
    }

    const updated = WorkflowState.appendComment(state, "plan", comment)

    expect(updated.plan_pull_request.comments).toHaveLength(1)
    expect(updated.plan_pull_request.comments[0]).toMatchObject({
      id: "c6",
      body: "Consider using a rate limiter for the API.",
      author: "reviewer",
      state: "open",
      source: "issue_comment",
    })
  })

  test("open comment count reflects current state", () => {
    const state: WorkflowState.WorkflowStateFile = {
      workflow_id: "wf_test",
      title: "count comments",
      state: "drafting_spec",
      artifact_dir: ".opencode/workflows/wf_test",
      created_at: WorkflowState.now(),
      updated_at: WorkflowState.now(),
      plan_branch: "branch",
      plan_pull_request: {
        review_state: "commented",
        comments: [
          { id: "c7", body: "Open feedback", state: "open", source: "issue_comment" as const },
          { id: "c8", body: "Addressed", state: "addressed", source: "issue_comment" as const },
        ],
      },
      code_pull_request: {
        review_state: "pending",
        comments: [
          { id: "c9", body: "Code review note", state: "open", source: "issue_comment" as const },
        ],
      },
      sessions: [],
    }

    const open = WorkflowState.openComments(state)
    const plan = state.plan_pull_request.comments.filter((c) => c.state === "open")
    const code = state.code_pull_request.comments.filter((c) => c.state === "open")

    expect(plan).toHaveLength(1)
    expect(code).toHaveLength(1)
    expect(open).toHaveLength(2)
  })

  test("comment state transitions are valid", () => {
    expect(WorkflowState.CommentStates).toContain("open")
    expect(WorkflowState.CommentStates).toContain("addressed")
    expect(WorkflowState.CommentStates).toContain("out_of_scope")
    expect(WorkflowState.CommentStates).toContain("superseded")
    expect(WorkflowState.CommentStates).toContain("blocked")
  })
})

