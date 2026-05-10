import { describe, expect, test } from "bun:test"
import type { WorkflowStateFile } from "../../../../src/workflow/state"
import {
  workflowActiveSession,
  workflowNeedsInput,
  workflowOpenCommentCount,
  workflowSessionPrompt,
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
})
