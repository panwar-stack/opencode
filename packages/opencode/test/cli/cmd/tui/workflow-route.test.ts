import { describe, expect, test } from "bun:test"
import type { WorkflowStateFile } from "../../../../src/workflow/state"
import {
  workflowActiveSession,
  workflowAmendmentInput,
  workflowDetailActions,
  workflowNeedsInput,
  workflowOpenCommentCount,
  workflowOpenSessionRoute,
  workflowPullRequestLabel,
  workflowReviewLabel,
  workflowSessionPrompt,
  workflowStateLabel,
  workflowSteeringInput,
  workflowTabs,
} from "../../../../src/cli/cmd/tui/routes/workflow"

const workflow = {
  workflow_id: "wf_test",
  title: "Audit workflow TUI",
  state: "executing",
  artifact_dir: ".opencode/workflows/wf_test",
  created_at: "2026-05-10T00:00:00.000Z",
  updated_at: "2026-05-10T00:05:00.000Z",
  plan_branch: "workflow/wf_test/plan",
  code_branch: "workflow/wf_test/code",
  approved_spec_hash: "abcdef1234567890",
  approved_plan_commit: "1234567890abcdef",
  current_task: "Wire workflow sessions into TUI",
  active_session_id: "ses_executor",
  user_input_needed: "Confirm scope amendment",
  plan_pull_request: {
    number: 10,
    url: "https://github.com/acme/repo/pull/10",
    branch: "workflow/wf_test/plan",
    head_commit: "abcdef1234567890",
    review_state: "approved",
    comments: [
      {
        id: "plan-open",
        body: "Please clarify task ordering",
        state: "open",
        source: "review_comment",
      },
      {
        id: "plan-done",
        body: "Resolved",
        state: "addressed",
        source: "issue_comment",
      },
    ],
  },
  code_pull_request: {
    number: 11,
    url: "https://github.com/acme/repo/pull/11",
    branch: "workflow/wf_test/code",
    head_commit: "1234567890abcdef",
    review_state: "changes_requested",
    comments: [
      {
        id: "code-open",
        body: "Needs a TUI signal",
        state: "open",
        source: "review",
      },
    ],
  },
  sessions: [
    {
      id: "ses_executor",
      role: "executor",
      status: "active",
      task: "Wire workflow sessions into TUI",
      created_at: "2026-05-10T00:01:00.000Z",
      updated_at: "2026-05-10T00:04:00.000Z",
      github_comment_url: "https://github.com/acme/repo/pull/11#discussion_r1",
    },
  ],
} satisfies WorkflowStateFile

describe("workflow TUI route helpers", () => {
  test("lists every workflow detail panel rendered by the route", () => {
    expect(workflowTabs().map((tab) => [tab.id, tab.label])).toEqual([
      ["spec", "Spec"],
      ["tasks", "Tasks"],
      ["impact", "Impact"],
      ["github", "GitHub"],
      ["sessions", "Sessions"],
      ["changes", "Changes"],
      ["decisions", "Decisions"],
      ["amendments", "Amendments"],
    ])
  })

  test("counts open comments across plan and code PRs", () => {
    expect(workflowOpenCommentCount(workflow)).toBe(2)
  })

  test("surfaces workflow input-needed state", () => {
    const sessionNeedingInput = { ...workflow.sessions[0], input_needed: "Reviewer answer required" }

    expect(workflowNeedsInput(workflow)).toBe(true)
    expect(
      workflowNeedsInput({
        ...workflow,
        user_input_needed: undefined,
        sessions: [sessionNeedingInput],
      }),
    ).toBe(true)
  })

  test("finds active session and builds session route context", () => {
    const session = workflowActiveSession(workflow)

    expect(session?.id).toBe("ses_executor")
    expect(workflowSessionPrompt(workflow, session!).input).toContain("Workflow context: Audit workflow TUI (wf_test)")
    expect(workflowSessionPrompt(workflow, session!).input).toContain("Approved plan commit: 1234567890abcdef")
  })

  test("builds session routes for active and selected workflow sessions", () => {
    expect(workflowOpenSessionRoute(workflow)?.sessionID).toBe("ses_executor")
    expect(workflowOpenSessionRoute(workflow)?.prompt.input).toContain("Session: executor ses_executor")
    expect(workflowOpenSessionRoute({ ...workflow, active_session_id: undefined })).toBeUndefined()
    expect(workflowOpenSessionRoute(workflow, "missing")).toBeUndefined()
  })

  test("formats state and review labels used by workflow list and detail rows", () => {
    expect(workflowStateLabel("awaiting_code_review")).toBe("Awaiting Code Review")
    expect(workflowReviewLabel("changes_requested")).toBe("Changes Requested")
    expect(workflowPullRequestLabel(workflow.code_pull_request)).toBe("#11 (Changes Requested)")
    expect(workflowPullRequestLabel({ ...workflow.plan_pull_request, number: undefined })).toBe("-")
  })

  test("describes detail actions for active sessions and amendment-only controls", () => {
    expect(workflowDetailActions(workflow).map((action) => [action.id, action.label, action.enabled])).toEqual([
      ["open_session", "open session", true],
      ["steer", "steer", true],
      ["sync", "sync", true],
      ["revise", "revise", true],
      ["submit_plan", "submit plan", true],
      ["run", "run", true],
      ["submit_code", "submit code", true],
      ["pause", "pause", true],
      ["resume", "resume", true],
    ])

    const pausedWithoutSession = {
      ...workflow,
      active_session_id: undefined,
      state: "paused",
    } satisfies WorkflowStateFile

    expect(workflowDetailActions(pausedWithoutSession).find((action) => action.id === "open_session")?.enabled).toBe(
      false,
    )
    expect(workflowDetailActions(pausedWithoutSession).find((action) => action.id === "steer")?.enabled).toBe(false)

    const amendment = {
      ...workflow,
      state: "needs_amendment",
    } satisfies WorkflowStateFile

    expect(workflowDetailActions(amendment).map((action) => action.id)).toEqual(
      expect.arrayContaining(["approve_amendment", "reject_amendment"]),
    )
  })

  test("normalizes steering and amendment action inputs", () => {
    expect(workflowSteeringInput(workflow, "/repo", "  continue with tests  ")).toEqual({
      directory: "/repo",
      workflowID: "wf_test",
      sessionID: "ses_executor",
      instruction: "continue with tests",
    })
    expect(workflowSteeringInput(workflow, "/repo", "   ")).toBeUndefined()
    expect(workflowSteeringInput({ ...workflow, active_session_id: undefined }, "/repo", "continue")).toBeUndefined()

    expect(workflowAmendmentInput(workflow, "/repo", true, "  approved because impact is documented  ")).toEqual({
      directory: "/repo",
      workflowID: "wf_test",
      approve: true,
      reason: "approved because impact is documented",
    })
    expect(workflowAmendmentInput(workflow, "/repo", false, "   ")).toEqual({
      directory: "/repo",
      workflowID: "wf_test",
      approve: false,
      reason: undefined,
    })
  })
})
