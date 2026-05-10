import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  WorkflowAmendmentApproveCommand,
  WorkflowBranchCommand,
  WorkflowCommitCommand,
  WorkflowDiffCommand,
  WorkflowListCommand,
  WorkflowPauseCommand,
  WorkflowResumeCommand,
  WorkflowRevisePlanCommand,
  WorkflowRunCommand,
  WorkflowSessionCommand,
  WorkflowSessionsCommand,
  WorkflowStartCommand,
  WorkflowStatusCommand,
  WorkflowSteerCommand,
  WorkflowSubmitCodeCommand,
  WorkflowSubmitPlanCommand,
  WorkflowSyncGithubCommand,
} from "../../src/cli/cmd/workflow"
import { WorkflowPaths, WorkflowResponse } from "../../src/server/routes/instance/httpapi/groups/workflow"

describe("workflow CLI and HTTP API surface", () => {
  test("exposes expected workflow CLI commands", () => {
    expect([
      WorkflowStartCommand.command,
      WorkflowStatusCommand.command,
      WorkflowSubmitPlanCommand.command,
      WorkflowSyncGithubCommand.command,
      WorkflowRevisePlanCommand.command,
      WorkflowRunCommand.command,
      WorkflowSubmitCodeCommand.command,
      WorkflowPauseCommand.command,
      WorkflowResumeCommand.command,
      WorkflowListCommand.command,
      WorkflowSessionsCommand.command,
      WorkflowSessionCommand.command,
      WorkflowSteerCommand.command,
      WorkflowBranchCommand.command,
      WorkflowDiffCommand.command,
      WorkflowCommitCommand.command,
      WorkflowAmendmentApproveCommand.command,
    ]).toEqual([
      "start <title>",
      "status [workflowID]",
      "plan <workflowID>",
      "github <workflowID>",
      "revise plan <workflowID>",
      "run <workflowID>",
      "code <workflowID>",
      "pause <workflowID>",
      "resume <workflowID>",
      "list",
      "sessions <workflowID>",
      "session <workflowID> <sessionID>",
      "steer <workflowID> <sessionID> <instruction...>",
      "branch <workflowID>",
      "diff <workflowID>",
      "commit <workflowID>",
      "approve <workflowID>",
    ])
  })

  test("exposes expected workflow HTTP route paths", () => {
    expect(WorkflowPaths).toEqual({
      list: "/workflow",
      create: "/workflow",
      get: "/workflow/:workflowID",
      submitPlan: "/workflow/:workflowID/submit-plan",
      syncGithub: "/workflow/:workflowID/sync-github",
      revisePlan: "/workflow/:workflowID/revise-plan",
      run: "/workflow/:workflowID/run",
      submitCode: "/workflow/:workflowID/submit-code",
      pause: "/workflow/:workflowID/pause",
      resume: "/workflow/:workflowID/resume",
      sessions: "/workflow/:workflowID/sessions",
      getSession: "/workflow/:workflowID/sessions/:sessionID",
      steer: "/workflow/:workflowID/sessions/:sessionID/steer",
      amendmentApprove: "/workflow/:workflowID/amendment/approve",
    })
  })

  test("keeps validation changed files visible in workflow responses", () => {
    expect(
      Schema.decodeUnknownSync(WorkflowResponse)({
        workflow_id: "wf_surface",
        title: "Surface",
        state: "awaiting_plan_review",
        artifact_dir: ".opencode/workflows/wf_surface",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        plan_branch: "opencode/workflow/wf_surface-plan",
        last_validation: {
          ok: false,
          summary: "Changed files outside approved impact boundary: src/out.ts",
          checked_at: "2026-01-01T00:00:00.000Z",
          files: ["src/out.ts"],
          allowed_paths: ["packages/opencode/src/**"],
        },
        plan_pull_request: {
          review_state: "changes_requested",
          comments: [],
        },
        code_pull_request: {
          review_state: "none",
          comments: [],
        },
        sessions: [],
      }).last_validation,
    ).toMatchObject({
      files: ["src/out.ts"],
      allowed_paths: ["packages/opencode/src/**"],
    })
  })
})
