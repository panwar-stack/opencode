import { BusEvent } from "@/bus/bus-event"
import { Schema } from "effect"

export const WorkflowCreated = BusEvent.define(
  "workflow.created",
  Schema.Struct({
    workflow_id: Schema.String,
    title: Schema.String,
    state: Schema.String,
  }),
)

export const WorkflowUpdated = BusEvent.define(
  "workflow.updated",
  Schema.Struct({
    workflow_id: Schema.String,
    previous_state: Schema.optional(Schema.String),
    new_state: Schema.String,
    action: Schema.optional(Schema.String),
  }),
)

export const PlanPullRequestSubmitted = BusEvent.define(
  "workflow.plan_pull_request.submitted",
  Schema.Struct({
    workflow_id: Schema.String,
    pull_request: Schema.optional(Schema.Number),
    url: Schema.optional(Schema.String),
    head_commit: Schema.optional(Schema.String),
    approved_spec_hash: Schema.optional(Schema.String),
  }),
)

export const PlanReviewCommentReceived = BusEvent.define(
  "workflow.plan_review.comment_received",
  Schema.Struct({
    workflow_id: Schema.String,
    pull_request: Schema.Number,
    comment_id: Schema.String,
    author: Schema.optional(Schema.String),
  }),
)

export const PlanReviewCommentAddressed = BusEvent.define(
  "workflow.plan_review.comment_addressed",
  Schema.Struct({
    workflow_id: Schema.String,
    pull_request: Schema.Number,
    comment_id: Schema.String,
  }),
)

export const PlanReviewApproved = BusEvent.define(
  "workflow.plan_review.approved",
  Schema.Struct({
    workflow_id: Schema.String,
    pull_request: Schema.Number,
    approved_commit: Schema.String,
    approved_spec_hash: Schema.String,
  }),
)

export const ExecutionPaused = BusEvent.define(
  "workflow.execution.paused",
  Schema.Struct({
    workflow_id: Schema.String,
    reason: Schema.String,
  }),
)

export const ExecutionStarted = BusEvent.define(
  "workflow.execution.started",
  Schema.Struct({
    workflow_id: Schema.String,
    code_branch: Schema.String,
    approved_spec_hash: Schema.String,
  }),
)

export const CodePullRequestSubmitted = BusEvent.define(
  "workflow.code_pull_request.submitted",
  Schema.Struct({
    workflow_id: Schema.String,
    pull_request: Schema.optional(Schema.Number),
    url: Schema.optional(Schema.String),
    head_commit: Schema.optional(Schema.String),
  }),
)

export const CodeReviewCommentReceived = BusEvent.define(
  "workflow.code_review.comment_received",
  Schema.Struct({
    workflow_id: Schema.String,
    pull_request: Schema.Number,
    comment_id: Schema.String,
    author: Schema.optional(Schema.String),
  }),
)

export const CodeReviewCommentAddressed = BusEvent.define(
  "workflow.code_review.comment_addressed",
  Schema.Struct({
    workflow_id: Schema.String,
    pull_request: Schema.Number,
    comment_id: Schema.String,
  }),
)

export const CodeReviewApproved = BusEvent.define(
  "workflow.code_review.approved",
  Schema.Struct({
    workflow_id: Schema.String,
    pull_request: Schema.Number,
  }),
)

export const AmendmentRequired = BusEvent.define(
  "workflow.amendment.required",
  Schema.Struct({
    workflow_id: Schema.String,
    reason: Schema.String,
  }),
)

export const WorkflowCompleted = BusEvent.define(
  "workflow.completed",
  Schema.Struct({
    workflow_id: Schema.String,
    pull_request: Schema.Number,
  }),
)

export const WorkflowFailed = BusEvent.define(
  "workflow.failed",
  Schema.Struct({
    workflow_id: Schema.String,
    reason: Schema.String,
  }),
)

export const SessionCreated = BusEvent.define(
  "workflow.session.created",
  Schema.Struct({
    workflow_id: Schema.String,
    session_id: Schema.String,
    role: Schema.String,
  }),
)

export const SessionUpdated = BusEvent.define(
  "workflow.session.updated",
  Schema.Struct({
    workflow_id: Schema.String,
    session_id: Schema.String,
    role: Schema.String,
    status: Schema.String,
  }),
)

export const SessionPaused = BusEvent.define(
  "workflow.session.paused",
  Schema.Struct({
    workflow_id: Schema.String,
    session_id: Schema.String,
    role: Schema.String,
  }),
)

export const SessionResumed = BusEvent.define(
  "workflow.session.resumed",
  Schema.Struct({
    workflow_id: Schema.String,
    session_id: Schema.String,
    role: Schema.String,
  }),
)

export const SessionSteered = BusEvent.define(
  "workflow.session.steered",
  Schema.Struct({
    workflow_id: Schema.String,
    session_id: Schema.String,
    instruction: Schema.String,
    github_comment_url: Schema.optional(Schema.String),
  }),
)

export const SessionFailed = BusEvent.define(
  "workflow.session.failed",
  Schema.Struct({
    workflow_id: Schema.String,
    session_id: Schema.String,
    role: Schema.String,
    reason: Schema.optional(Schema.String),
  }),
)

export const SessionCompleted = BusEvent.define(
  "workflow.session.completed",
  Schema.Struct({
    workflow_id: Schema.String,
    session_id: Schema.String,
    role: Schema.String,
  }),
)

export const WorkflowRecovered = BusEvent.define(
  "workflow.recovered",
  Schema.Struct({
    workflow_id: Schema.String,
    previous_state: Schema.String,
    new_state: Schema.String,
    recovery_summary: Schema.String,
  }),
)

export const ReviewSyncNeeded = BusEvent.define(
  "workflow.review_sync.needed",
  Schema.Struct({
    workflow_id: Schema.String,
    directory: Schema.String,
    pull_request: Schema.Union([Schema.Literal("plan"), Schema.Literal("code")]),
    comment_ids: Schema.optional(Schema.Array(Schema.String)),
  }),
)

export * as WorkflowEvents from "./events"
