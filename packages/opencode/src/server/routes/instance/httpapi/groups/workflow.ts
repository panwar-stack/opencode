import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "../middleware/workspace-routing"
import { ApiNotFoundError } from "../errors"
import { described } from "./metadata"

const root = "/workflow"

export const CreateRequest = Schema.Struct({
  title: Schema.String,
  local_draft: Schema.optional(Schema.Boolean),
  base: Schema.optional(Schema.String),
})

export const SubmitPlanRequest = Schema.Struct({
  base: Schema.optional(Schema.String),
  dry_run: Schema.optional(Schema.Boolean),
})

export const SubmitCodeRequest = Schema.Struct({
  base: Schema.optional(Schema.String),
  dry_run: Schema.optional(Schema.Boolean),
})

export const RevisePlanRequest = Schema.Struct({
  instruction: Schema.optional(Schema.String),
  github_comment_url: Schema.optional(Schema.String),
})

export const SteerRequest = Schema.Struct({
  instruction: Schema.String,
  github_comment_url: Schema.optional(Schema.String),
})

export const AmendmentApproveRequest = Schema.Struct({
  approve: Schema.Boolean,
  reason: Schema.optional(Schema.String),
})

const ValidationInfo = Schema.Struct({
  ok: Schema.Boolean,
  summary: Schema.String,
  checked_at: Schema.String,
  files: Schema.optional(Schema.Array(Schema.String)),
  allowed_paths: Schema.optional(Schema.Array(Schema.String)),
})

const CommentInfo = Schema.Struct({
  id: Schema.String,
  url: Schema.optional(Schema.String),
  author: Schema.optional(Schema.String),
  body: Schema.String,
  state: Schema.String,
  source: Schema.String,
  path: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Number),
  created_at: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.String),
})

const PullRequestInfo = Schema.Struct({
  number: Schema.optional(Schema.Number),
  url: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  head_commit: Schema.optional(Schema.String),
  review_state: Schema.String,
  reviewers: Schema.optional(Schema.Array(Schema.String)),
  latest_review_at: Schema.optional(Schema.String),
  latest_review_url: Schema.optional(Schema.String),
  approved_by: Schema.optional(Schema.String),
  approved_at: Schema.optional(Schema.String),
  comments: Schema.Array(CommentInfo),
})

const SessionInfo = Schema.Struct({
  id: Schema.String,
  role: Schema.String,
  status: Schema.String,
  task: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  github_comment_url: Schema.optional(Schema.String),
})

export const WorkflowResponse = Schema.Struct({
  workflow_id: Schema.String,
  title: Schema.String,
  state: Schema.String,
  artifact_dir: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  plan_branch: Schema.String,
  code_branch: Schema.optional(Schema.String),
  approved_spec_hash: Schema.optional(Schema.String),
  approved_plan_commit: Schema.optional(Schema.String),
  current_task: Schema.optional(Schema.String),
  active_session_id: Schema.optional(Schema.String),
  user_input_needed: Schema.optional(Schema.String),
  last_validation: Schema.optional(ValidationInfo),
  plan_pull_request: PullRequestInfo,
  code_pull_request: PullRequestInfo,
  sessions: Schema.Array(SessionInfo),
})

export const WorkflowPaths = {
  list: root,
  create: root,
  get: `${root}/:workflowID`,
  submitPlan: `${root}/:workflowID/submit-plan`,
  syncGithub: `${root}/:workflowID/sync-github`,
  revisePlan: `${root}/:workflowID/revise-plan`,
  run: `${root}/:workflowID/run`,
  submitCode: `${root}/:workflowID/submit-code`,
  pause: `${root}/:workflowID/pause`,
  resume: `${root}/:workflowID/resume`,
  recover: `${root}/:workflowID/recover`,
  sessions: `${root}/:workflowID/sessions`,
  getSession: `${root}/:workflowID/sessions/:sessionID`,
  steer: `${root}/:workflowID/sessions/:sessionID/steer`,
  amendmentApprove: `${root}/:workflowID/amendment/approve`,
} as const

export const WorkflowApiGroup = HttpApiGroup.make("workflow")
  .add(
    HttpApiEndpoint.get("list", WorkflowPaths.list, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(WorkflowResponse), "List of workflows"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.list",
            summary: "List workflows",
            description: "Get a list of all workflows sorted by most recently updated.",
          }),
        ),
        HttpApiEndpoint.post("create", WorkflowPaths.create, {
          query: WorkspaceRoutingQuery,
          payload: CreateRequest,
          success: described(WorkflowResponse, "Created workflow"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.create",
            summary: "Create workflow",
            description: "Create a new autonomous workflow with plan artifacts.",
          }),
        ),
        HttpApiEndpoint.get("get", WorkflowPaths.get, {
          params: { workflowID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(WorkflowResponse, "Workflow detail"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.get",
            summary: "Get workflow",
            description: "Retrieve detailed information about a specific workflow.",
          }),
        ),
        HttpApiEndpoint.post("submitPlan", WorkflowPaths.submitPlan, {
          params: { workflowID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: SubmitPlanRequest,
          success: described(WorkflowResponse, "Plan submitted"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.submitPlan",
            summary: "Submit plan pull request",
            description: "Validate and submit the workflow plan as a GitHub pull request.",
          }),
        ),
        HttpApiEndpoint.post("syncGithub", WorkflowPaths.syncGithub, {
          params: { workflowID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(WorkflowResponse, "GitHub state synced"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.syncGithub",
            summary: "Sync GitHub state",
            description: "Sync pull request review state and comments from GitHub.",
          }),
        ),
        HttpApiEndpoint.post("revisePlan", WorkflowPaths.revisePlan, {
          params: { workflowID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: RevisePlanRequest,
          success: described(WorkflowResponse, "Plan revision started"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.revisePlan",
            summary: "Revise workflow plan",
            description: "Start a plan revision session from review feedback.",
          }),
        ),
        HttpApiEndpoint.post("run", WorkflowPaths.run, {
          params: { workflowID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(WorkflowResponse, "Execution started"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.run",
            summary: "Run approved plan",
            description: "Start implementing the approved workflow plan.",
          }),
        ),
        HttpApiEndpoint.post("submitCode", WorkflowPaths.submitCode, {
          params: { workflowID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: SubmitCodeRequest,
          success: described(WorkflowResponse, "Code PR submitted"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.submitCode",
            summary: "Submit code pull request",
            description: "Validate and submit the workflow implementation as a GitHub pull request.",
          }),
        ),
        HttpApiEndpoint.post("pause", WorkflowPaths.pause, {
          params: { workflowID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(WorkflowResponse, "Workflow paused"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.pause",
            summary: "Pause workflow",
            description: "Pause an active workflow.",
          }),
        ),
        HttpApiEndpoint.post("resume", WorkflowPaths.resume, {
          params: { workflowID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(WorkflowResponse, "Workflow resumed"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.resume",
            summary: "Resume workflow",
            description: "Resume a paused workflow.",
          }),
        ),
        HttpApiEndpoint.post("recover", WorkflowPaths.recover, {
          params: { workflowID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(WorkflowResponse, "Workflow recovered"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.recover",
            summary: "Recover workflow",
            description: "Attempt to recover a workflow from a failed, paused, or interrupted state.",
          }),
        ),
        HttpApiEndpoint.get("sessions", WorkflowPaths.sessions, {
          params: { workflowID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(SessionInfo), "List of workflow sessions"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.sessions",
            summary: "List workflow sessions",
            description: "Get all sessions associated with a workflow.",
          }),
        ),
        HttpApiEndpoint.get("getSession", WorkflowPaths.getSession, {
          params: { workflowID: Schema.String, sessionID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(SessionInfo, "Workflow session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.getSession",
            summary: "Get workflow session",
            description: "Get a specific workflow session with role and task information.",
          }),
        ),
        HttpApiEndpoint.post("steer", WorkflowPaths.steer, {
          params: { workflowID: Schema.String, sessionID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: SteerRequest,
          success: described(WorkflowResponse, "Session steered"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.steer",
            summary: "Steer workflow session",
            description: "Send steering instructions to a workflow session.",
          }),
        ),
        HttpApiEndpoint.post("amendmentApprove", WorkflowPaths.amendmentApprove, {
          params: { workflowID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: AmendmentApproveRequest,
          success: described(WorkflowResponse, "Amendment processed"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.amendmentApprove",
            summary: "Approve or deny amendment",
            description: "Approve or deny a scope amendment request.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "workflow",
          description: "Workflow management routes for autonomous GitHub-reviewed workflows.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization)

export const WorkflowApi = HttpApi.make("workflow")
  .add(WorkflowApiGroup)
