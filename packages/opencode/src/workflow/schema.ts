import { Schema } from "effect"
import { Identifier } from "@/id/id"
import { zod, ZodOverride } from "@opencode-ai/core/effect-zod"
import { withStatics } from "@opencode-ai/core/schema"

export const WorkflowID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("workflow") }).pipe(
  Schema.brand("WorkflowID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("workflow", id)),
    zod: zod(s),
  })),
)

export type WorkflowID = Schema.Schema.Type<typeof WorkflowID>

export const WorkflowSessionID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("workflow_session") }).pipe(
  Schema.brand("WorkflowSessionID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("workflow_session", id)),
    zod: zod(s),
  })),
)

export type WorkflowSessionID = Schema.Schema.Type<typeof WorkflowSessionID>

export const WorkflowStatus = Schema.Literals([
  "created",
  "drafting_spec",
  "submitting_plan_pull_request",
  "awaiting_plan_review",
  "addressing_plan_comments",
  "plan_approved",
  "executing",
  "validating",
  "submitting_code_pull_request",
  "awaiting_code_review",
  "addressing_code_comments",
  "needs_amendment",
  "paused",
  "completed",
  "failed",
  "cancelled",
])

export type WorkflowStatus = Schema.Schema.Type<typeof WorkflowStatus>

export const SessionRole = Schema.Literals([
  "planner",
  "plan_reviewer",
  "executor",
  "validator",
  "code_reviewer",
  "amendment",
  "recovery",
])

export type SessionRole = Schema.Schema.Type<typeof SessionRole>

export const SessionStatus = Schema.Literals([
  "created",
  "active",
  "waiting",
  "paused",
  "complete",
  "failed",
  "cancelled",
])

export type SessionStatus = Schema.Schema.Type<typeof SessionStatus>

export const CommentStatus = Schema.Literals([
  "open",
  "addressed",
  "out_of_scope",
  "superseded",
  "blocked",
])

export type CommentStatus = Schema.Schema.Type<typeof CommentStatus>

export const ReviewState = Schema.Literals([
  "pending",
  "commented",
  "approved",
  "changes_requested",
  "dismissed",
])

export type ReviewState = Schema.Schema.Type<typeof ReviewState>

export const PullRequestType = Schema.Literals(["plan", "code"])

export type PullRequestType = Schema.Schema.Type<typeof PullRequestType>

export const PullRequestInfo = Schema.Struct({
  number: Schema.optional(Schema.Number),
  url: Schema.optional(Schema.String),
  branch: Schema.String,
  head_commit: Schema.optional(Schema.String),
  review_state: ReviewState,
})

export type PullRequestInfo = Schema.Schema.Type<typeof PullRequestInfo>

export const Comment = Schema.Struct({
  pull_request_type: PullRequestType,
  comment_id: Schema.Number,
  url: Schema.String,
  status: CommentStatus,
  assigned_session_id: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  author: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
})

export type Comment = Schema.Schema.Type<typeof Comment>

export const WorkflowSession = Schema.Struct({
  id: Schema.String,
  role: SessionRole,
  agent: Schema.String,
  status: SessionStatus,
  created_at: Schema.String,
  last_activity_at: Schema.String,
  current_task_id: Schema.optional(Schema.NullOr(Schema.String)),
  files_touched: Schema.optional(Schema.Array(Schema.String)),
  needs_input: Schema.optional(Schema.Boolean),
})

export type WorkflowSession = Schema.Schema.Type<typeof WorkflowSession>

export const WorkflowState = Schema.Struct({
  id: WorkflowID,
  title: Schema.String,
  status: WorkflowStatus,
  request: Schema.String,
  spec_version: Schema.Number,
  approved_spec_hash: Schema.optional(Schema.String),
  approved_plan_commit: Schema.optional(Schema.String),
  plan_pull_request: Schema.optional(PullRequestInfo),
  code_pull_request: Schema.optional(PullRequestInfo),
  current_task_id: Schema.optional(Schema.String),
  open_github_comments: Schema.optional(Schema.Array(Comment)),
  sessions: Schema.optional(Schema.Array(WorkflowSession)),
  created_at: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.String),
  max_steps: Schema.optional(Schema.Number),
  step_count: Schema.optional(Schema.Number),
  previous_status: Schema.optional(WorkflowStatus),
})

export type WorkflowState = Schema.Schema.Type<typeof WorkflowState>

export const DecisionEntry = Schema.Struct({
  time: Schema.String,
  workflow_id: Schema.String,
  session_id: Schema.optional(Schema.String),
  actor: Schema.String,
  type: Schema.String,
  previous_state: Schema.optional(Schema.String),
  new_state: Schema.optional(Schema.String),
  reason: Schema.String,
  evidence: Schema.optional(Schema.String),
  pull_request: Schema.optional(Schema.Number),
  comment_url: Schema.optional(Schema.String),
})

export type DecisionEntry = Schema.Schema.Type<typeof DecisionEntry>

export const GitHubState = Schema.Struct({
  plan_pull_request: Schema.optional(PullRequestInfo),
  plan_review_state: Schema.optional(ReviewState),
  plan_open_comments: Schema.optional(Schema.Array(Comment)),
  plan_addressed_comments: Schema.optional(Schema.Array(Comment)),
  approved_plan_evidence: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  code_pull_request: Schema.optional(PullRequestInfo),
  code_review_state: Schema.optional(ReviewState),
  code_open_comments: Schema.optional(Schema.Array(Comment)),
  code_addressed_comments: Schema.optional(Schema.Array(Comment)),
  out_of_scope_comments: Schema.optional(Schema.Array(Comment)),
  review_response_log: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        pull_request: Schema.Number,
        comment_id: Schema.Number,
        comment_url: Schema.String,
        session_id: Schema.String,
        summary: Schema.String,
        commit: Schema.String,
      }),
    ),
  ),
})

export type GitHubState = Schema.Schema.Type<typeof GitHubState>
