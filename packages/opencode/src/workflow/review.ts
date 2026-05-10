import { Context, Effect, Layer } from "effect"
import { Bus } from "@/bus"
import { Workflow } from "./workflow"
import { WorkflowState, type PullRequestKind, type ReviewComment, type CommentState } from "./state"
import { WorkflowEvents } from "./events"

export type ReviewSyncResult = {
  readonly new_comments: number
  readonly resolved_comments: number
  readonly review_state_changed: boolean
}

export type CommentClassification = {
  readonly classification: "in_scope" | "out_of_scope" | "already_addressed" | "needs_clarification"
  readonly reasoning: string
}

export interface Interface {
  readonly syncReviews: (
    directory: string,
    workflowID: string,
    prType: PullRequestKind,
  ) => Effect.Effect<ReviewSyncResult, Error>

  readonly classifyComment: (
    comment: ReviewComment,
    spec: string,
    tasks: string,
    impact: string,
  ) => CommentClassification

  readonly createResponseTask: (
    directory: string,
    workflowID: string,
    comment: ReviewComment,
  ) => Effect.Effect<string, Error>

  readonly addressComment: (
    directory: string,
    workflowID: string,
    commentId: number,
  ) => Effect.Effect<void, Error>

  readonly markComment: (
    directory: string,
    workflowID: string,
    pullRequest: PullRequestKind,
    commentID: string,
    status: CommentState,
    reply?: string,
  ) => Effect.Effect<void, Error>

  readonly replyToComment: (
    directory: string,
    workflowID: string,
    prType: PullRequestKind,
    commentId: number,
    body: string,
  ) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowReview") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const workflow = yield* Workflow.Service

    const syncReviews = Effect.fn("WorkflowReview.syncReviews")(function* (
      directory: string,
      workflowID: string,
      prType: PullRequestKind,
    ) {
      const before = yield* workflow.get(directory, workflowID)
      const after = yield* workflow.syncGithub({ directory, workflowID })

      const pr = prType === "plan" ? before.plan_pull_request : before.code_pull_request
      const prAfter = prType === "plan" ? after.plan_pull_request : after.code_pull_request

      const beforeCommentIds = new Set(pr.comments.map((c) => c.id))
      const afterCommentIds = new Set(prAfter.comments.map((c) => c.id))

      const new_comments = [...afterCommentIds].filter((id) => !beforeCommentIds.has(id)).length
      const resolved_comments = [...beforeCommentIds].filter((id) => !afterCommentIds.has(id)).length
      const review_state_changed = pr.review_state !== prAfter.review_state

      if (review_state_changed && WorkflowState.isApprovedReview(prAfter.review_state)) {
        yield* bus.publish(
          prType === "plan" ? WorkflowEvents.PlanReviewApproved : WorkflowEvents.CodeReviewApproved,
          prType === "plan"
            ? {
                workflow_id: workflowID,
                pull_request: prAfter.number ?? 0,
                approved_commit: prAfter.head_commit ?? "",
                approved_spec_hash: after.approved_spec_hash ?? "",
              }
            : {
                workflow_id: workflowID,
                pull_request: prAfter.number ?? 0,
              },
        )
      }

      for (const id of [...afterCommentIds].filter((id) => !beforeCommentIds.has(id))) {
        const comment = prAfter.comments.find((c) => c.id === id)
        if (comment) {
          yield* bus.publish(
            prType === "plan" ? WorkflowEvents.PlanReviewCommentReceived : WorkflowEvents.CodeReviewCommentReceived,
            {
              workflow_id: workflowID,
              pull_request: prAfter.number ?? 0,
              comment_id: comment.id,
              author: comment.author,
            },
          )
        }
      }

      return { new_comments, resolved_comments, review_state_changed }
    })

    const classifyComment = (comment: ReviewComment, spec: string, tasks: string, impact: string): CommentClassification => {
        const body = comment.body.toLowerCase()
        const content = `${spec} ${tasks} ${impact}`.toLowerCase()

        const keywords = content.split(/\W+/).filter((w) => w.length > 3)
        const hasKeywordMatch = keywords.some((kw) => body.includes(kw))

        if (body.includes("already addressed") || body.includes("already fixed") || body.includes("already done")) {
          return {
            classification: "already_addressed" as const,
            reasoning: "Comment references changes that appear to already be addressed.",
          }
        }
        if (body.includes("out of scope") || body.includes("not in spec") || body.includes("not part of")) {
          return {
            classification: "out_of_scope" as const,
            reasoning: "Comment indicates the concern is outside the approved scope.",
          }
        }
        if (!hasKeywordMatch && (body.includes("clarif") || body.includes("explain") || body.includes("?"))) {
          return {
            classification: "needs_clarification" as const,
            reasoning: "Comment appears to request clarification rather than clear action.",
          }
        }
        if (hasKeywordMatch) {
          return {
            classification: "in_scope" as const,
            reasoning: "Comment topics match the approved specification and task list.",
          }
        }

        return {
          classification: "needs_clarification" as const,
          reasoning: "Unable to confidently classify; comment requires human review.",
        }
      }

    const createResponseTask = Effect.fn("WorkflowReview.createResponseTask")(
      function* (directory: string, workflowID: string, comment: ReviewComment) {
        const state = yield* workflow.get(directory, workflowID)
        const isPlanComment = state.plan_pull_request.comments.some((c) => c.id === comment.id)
        const pullRequest: PullRequestKind = isPlanComment ? "plan" : "code"

        yield* workflow.addComment({
          directory,
          workflowID,
          pullRequest,
          comment,
        })

        return `Address review comment from ${comment.author ?? "unknown"}: "${comment.body.slice(0, 80)}"`
      },
    )

    const addressComment = Effect.fn("WorkflowReview.addressComment")(
      function* (directory: string, workflowID: string, commentId: number) {
        yield* workflow.markReviewComment({
          directory,
          workflowID,
          pullRequest: "code",
          commentID: String(commentId),
          state: "addressed",
        })
      },
    )

    const markComment = Effect.fn("WorkflowReview.markComment")(
      function* (
        directory: string,
        workflowID: string,
        pullRequest: PullRequestKind,
        commentID: string,
        status: CommentState,
        reply?: string,
      ) {
        const state = yield* workflow.markReviewComment({
          directory,
          workflowID,
          pullRequest,
          commentID,
          state: status,
          summary: reply,
        })

        if (status === "addressed") {
          yield* bus.publish(WorkflowEvents.WorkflowUpdated, {
            workflow_id: workflowID,
            new_state: state.state,
            action: "comment.marked.addressed",
          })
        }
      },
    )

    const replyToComment = Effect.fn("WorkflowReview.replyToComment")(
      function* (
        directory: string,
        workflowID: string,
        prType: PullRequestKind,
        commentId: number,
        body: string,
      ) {
        const state = yield* workflow.get(directory, workflowID)
        const pr = prType === "plan" ? state.plan_pull_request : state.code_pull_request
        if (!pr.number) {
          return yield* Effect.fail(new Error(`No ${prType} pull request exists for workflow ${workflowID}`))
        }

        yield* workflow.addComment({
          directory,
          workflowID,
          pullRequest: prType,
          comment: {
            id: `reply-${commentId}-${Date.now()}`,
            body: `Reply to #${commentId}: ${body}`,
            author: "opencode",
          },
        })
      },
    )

    return Service.of({
      syncReviews,
      classifyComment,
      createResponseTask,
      addressComment,
      markComment,
      replyToComment,
    })
  }),
)

export * as WorkflowReview from "./review"
