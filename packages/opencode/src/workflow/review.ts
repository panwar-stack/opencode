import path from "path"
import { Context, Effect, Layer, Stream } from "effect"
import { Bus } from "@/bus"
import { Workflow } from "./workflow"
import { WorkflowGithub } from "./github"
import { WorkflowArtifact } from "./artifact"
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
  readonly syncReviews: (directory: string, workflowID: string, prType: PullRequestKind) => Effect.Effect<ReviewSyncResult, Error>

  readonly classifyComment: (comment: ReviewComment, spec: string, tasks: string, impact: string) => CommentClassification

  readonly createResponseTask: (directory: string, workflowID: string, comment: ReviewComment) => Effect.Effect<string, Error>

  readonly addressComment: (directory: string, workflowID: string, commentId: number) => Effect.Effect<void, Error>

  readonly markComment: (directory: string, workflowID: string, pullRequest: PullRequestKind, commentID: string, status: CommentState, reply?: string) => Effect.Effect<void, Error>

  readonly replyToComment: (directory: string, workflowID: string, prType: PullRequestKind, commentId: number, body: string) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowReview") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const workflow = yield* Workflow.Service
    const github = yield* WorkflowGithub.Service

    const repoFromUrl = (url?: string) => {
      const match = url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/)
      return match?.[1]
    }

    const syncReviews = Effect.fn("WorkflowReview.syncReviews")(function* (directory: string, workflowID: string, prType: PullRequestKind) {
      const before = yield* workflow.get(directory, workflowID)
      const after = yield* workflow.syncGithub({ directory, workflowID })

      const pr = prType === "plan" ? before.plan_pull_request : before.code_pull_request
      const prAfter = prType === "plan" ? after.plan_pull_request : after.code_pull_request

      const beforeCommentIds = new Set(pr.comments.map((c) => c.id))
      const afterCommentIds = new Set(prAfter.comments.map((c) => c.id))

      const newCommentIds = [...afterCommentIds].filter((id) => !beforeCommentIds.has(id))
      const new_comments = newCommentIds.length
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

      yield* processSyncedComments(directory, workflowID, prType, newCommentIds)

      return { new_comments, resolved_comments, review_state_changed }
    })

    const processSyncedComments = Effect.fn("WorkflowReview.processSyncedComments")(function* (directory: string, workflowID: string, prType: PullRequestKind, commentIds: readonly string[]) {
      const state = yield* workflow.get(directory, workflowID)
      const pr = prType === "plan" ? state.plan_pull_request : state.code_pull_request
      const artifactDir = path.join(directory, state.artifact_dir)
      const spec = yield* Effect.promise(() => Bun.file(path.join(artifactDir, "SPEC.md")).text()).pipe(Effect.catch(() => Effect.succeed("")))
      const tasks = yield* Effect.promise(() => Bun.file(path.join(artifactDir, "TASKS.md")).text()).pipe(Effect.catch(() => Effect.succeed("")))
      const impact = yield* Effect.promise(() => Bun.file(path.join(artifactDir, "IMPACT.md")).text()).pipe(Effect.catch(() => Effect.succeed("")))

      for (const id of commentIds) {
        const comment = pr.comments.find((c) => c.id === id && c.state === "open")
        if (!comment) continue

        yield* bus.publish(prType === "plan" ? WorkflowEvents.PlanReviewCommentReceived : WorkflowEvents.CodeReviewCommentReceived, {
          workflow_id: workflowID,
          pull_request: pr.number ?? 0,
          comment_id: comment.id,
          author: comment.author,
        })

        const classification = classifyComment(comment, spec, tasks, impact)

        const numId = /^\d+$/.test(comment.id) ? Number(comment.id) : undefined

        if (classification.classification === "out_of_scope") {
          yield* workflow.markReviewComment({
            directory,
            workflowID,
            pullRequest: prType,
            commentID: comment.id,
            state: "out_of_scope",
            summary: classification.reasoning,
          })
          if (numId !== undefined) {
            yield* replyToComment(directory, workflowID, prType, numId, `This concern falls outside the approved scope. ${classification.reasoning}`)
          }
        } else if (classification.classification === "in_scope") {
          const task = yield* createResponseTask(directory, workflowID, comment)
          if (numId !== undefined) {
            yield* replyToComment(directory, workflowID, prType, numId, `I've queued this in-scope review feedback as workflow response work: ${task}`)
          }
        } else if (classification.classification === "already_addressed") {
          yield* workflow.markReviewComment({
            directory,
            workflowID,
            pullRequest: prType,
            commentID: comment.id,
            state: "addressed",
            summary: classification.reasoning,
          })
          if (numId !== undefined) {
            yield* replyToComment(directory, workflowID, prType, numId, `This concern appears to already be addressed in the implementation. ${classification.reasoning}`)
          }
        } else if (classification.classification === "needs_clarification") {
          if (numId !== undefined) {
            yield* replyToComment(directory, workflowID, prType, numId, `Thanks for the feedback. I need clarification to address this properly. ${classification.reasoning}`)
          }
        }
      }
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

    const createResponseTask = Effect.fn("WorkflowReview.createResponseTask")(function* (directory: string, workflowID: string, comment: ReviewComment) {
      const state = yield* workflow.get(directory, workflowID)
      const isPlanComment = state.plan_pull_request.comments.some((c) => c.id === comment.id)
      const pullRequest: PullRequestKind = isPlanComment ? "plan" : "code"

      const exists = (pullRequest === "plan" ? state.plan_pull_request : state.code_pull_request).comments.some((c) => c.id === comment.id)
      const recorded = exists
        ? state
        : yield* workflow.addComment({
            directory,
            workflowID,
            pullRequest,
            comment,
          })

      const artifactDir = path.join(directory, recorded.artifact_dir)
      const tasksPath = path.join(artifactDir, "TASKS.md")
      const tasks = yield* Effect.promise(() => Bun.file(tasksPath).text()).pipe(Effect.catch(() => Effect.succeed("# Tasks\n")))
      const taskID = `review_${comment.id.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || Date.now().toString(36)}`
      if (!new RegExp(`\\b${taskID}\\b`).test(tasks)) {
        const files = comment.path ?? WorkflowArtifact.relativeArtifactDir(workflowID)
        const line = [
          `- [ ] ${taskID} | Address ${pullRequest} review comment from ${comment.author ?? "unknown"}: ${comment.body.replace(/\s+/g, " ").slice(0, 120)}`,
          `files: ${files}`,
          "validation: bun typecheck",
          "status: pending",
          "evidence: none",
          `github: ${comment.url ?? "none"}`,
        ].join(" | ")
        yield* Effect.promise(() => Bun.write(tasksPath, `${tasks.trimEnd()}\n${line}\n`))
      }

      const responseSession = {
        id: WorkflowState.createSessionID(),
        role: pullRequest === "plan" ? ("plan_reviewer" as const) : ("code_reviewer" as const),
        status: "waiting" as const,
        task: `Address review comment ${comment.id}`,
        agent: pullRequest === "plan" ? "plan_reviewer" : "code_reviewer",
        created_at: WorkflowState.now(),
        updated_at: WorkflowState.now(),
        github_comment_url: comment.url,
      }
      const existingSession = recorded.sessions.find((session) => session.github_comment_url === comment.url || session.task === responseSession.task)
      if (existingSession) return `${taskID} - Address review comment from ${comment.author ?? "unknown"}`

      const next = WorkflowState.upsertSession(yield* workflow.get(directory, workflowID), responseSession)
      yield* Effect.promise(() => WorkflowArtifact.writeState(directory, next))
      yield* Effect.promise(() => WorkflowArtifact.writeGithubSummary(directory, next))
      yield* Effect.promise(() =>
        WorkflowArtifact.appendDecision(directory, workflowID, {
          action: "workflow.review_response_task.created",
          session_id: responseSession.id,
          previous_state: state.state,
          new_state: next.state,
          actor: "opencode",
          summary: `Created response task ${taskID} for ${pullRequest} review comment ${comment.id}.`,
          pull_request: pullRequest === "plan" ? next.plan_pull_request.number : next.code_pull_request.number,
          github_comment_url: comment.url,
        }),
      )

      return `${taskID} - Address review comment from ${comment.author ?? "unknown"}`
    })

    const addressComment = Effect.fn("WorkflowReview.addressComment")(function* (directory: string, workflowID: string, commentId: number) {
      yield* workflow.markReviewComment({
        directory,
        workflowID,
        pullRequest: "code",
        commentID: String(commentId),
        state: "addressed",
      })
    })

    const markComment = Effect.fn("WorkflowReview.markComment")(function* (
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
    })

    const replyToComment = Effect.fn("WorkflowReview.replyToComment")(function* (directory: string, workflowID: string, prType: PullRequestKind, commentId: number, body: string) {
      const state = yield* workflow.get(directory, workflowID)
      const pr = prType === "plan" ? state.plan_pull_request : state.code_pull_request
      if (!pr.number) {
        return yield* Effect.fail(new Error(`No ${prType} pull request exists for workflow ${workflowID}`))
      }
      const repo = repoFromUrl(pr.url)
      if (!repo) return yield* Effect.fail(new Error(`No GitHub repository URL is recorded for ${prType} PR.`))

      if (prType === "code") {
        yield* github.addReplyToComment(repo, pr.number, String(commentId), body).pipe(Effect.catch(() => github.addComment(repo, pr.number!, body)))
      } else {
        yield* github.addComment(repo, pr.number, body)
      }

      const recorded = WorkflowState.appendComment(yield* workflow.get(directory, workflowID), prType, {
        id: `reply-${commentId}-${Date.now()}`,
        body: `Reply to #${commentId}: ${body}`,
        author: "opencode",
        state: "addressed",
      })
      yield* Effect.promise(() => WorkflowArtifact.writeState(directory, recorded))
      yield* Effect.promise(() => WorkflowArtifact.writeGithubSummary(directory, recorded))
    })

    yield* bus.subscribe(WorkflowEvents.ReviewSyncNeeded).pipe(
      Stream.runForEach((evt) =>
        (evt.properties.comment_ids?.length
          ? processSyncedComments(evt.properties.directory, evt.properties.workflow_id, evt.properties.pull_request, evt.properties.comment_ids)
          : syncReviews(evt.properties.directory, evt.properties.workflow_id, evt.properties.pull_request)
        ).pipe(Effect.catch(() => Effect.void)),
      ),
      Effect.forkScoped,
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

export const defaultLayer = layer.pipe(Layer.provide(WorkflowGithub.defaultLayer), Layer.provide(Workflow.defaultLayer))

export const workflowLayer = Layer.effect(
  Workflow.Service,
  Effect.gen(function* () {
    const workflow = yield* Workflow.Service
    yield* Service
    return workflow
  }),
).pipe(Layer.provide(Layer.mergeAll(Workflow.defaultLayer, defaultLayer)))

export * as WorkflowReview from "./review"
