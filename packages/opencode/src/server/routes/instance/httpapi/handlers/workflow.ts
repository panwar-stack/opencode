import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance"
import { Workflow } from "@/workflow/workflow"
import { WorkflowSession } from "@/workflow/session"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ApiNotFoundError } from "../errors"

function directoryFromRef(ctx: InstanceContext) {
  return ctx.worktree || ctx.directory
}

function asBadRequest<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
}

export const workflowHandlers = HttpApiBuilder.group(InstanceHttpApi, "workflow", (handlers) =>
  Effect.gen(function* () {
    const workflow = yield* Workflow.Service
    const wfSession = yield* WorkflowSession.Service

    const list = Effect.fn("WorkflowHttpApi.list")(function* () {
      const instance = yield* InstanceRef
      if (!instance) return yield* new HttpApiError.BadRequest({})
      return yield* workflow.all(directoryFromRef(instance))
    })

    const create = Effect.fn("WorkflowHttpApi.create")(function* (ctx: {
      readonly payload: { readonly title: string; readonly local_draft?: boolean; readonly base?: string }
    }) {
      const instance = yield* InstanceRef
      if (!instance) return yield* new HttpApiError.BadRequest({})
      const state = yield* asBadRequest(workflow.start({
        directory: directoryFromRef(instance),
        title: ctx.payload.title,
        localDraft: ctx.payload.local_draft,
      }))
      if (ctx.payload.local_draft) return state
      return yield* asBadRequest(workflow.submitPlan({
        directory: directoryFromRef(instance),
        workflowID: state.workflow_id,
        base: ctx.payload.base,
      }))
    })

    const get = Effect.fn("WorkflowHttpApi.get")(function* (ctx: {
      readonly params: { readonly workflowID: string }
    }) {
      const instance = yield* InstanceRef
      if (!instance) return yield* new HttpApiError.BadRequest({})
      return yield* workflow.get(directoryFromRef(instance), ctx.params.workflowID).pipe(
        Effect.mapError(
          () =>
            new ApiNotFoundError({
              name: "NotFoundError",
              data: { message: `Workflow not found: ${ctx.params.workflowID}` },
            }),
        ),
      )
    })

    const submitPlan = Effect.fn("WorkflowHttpApi.submitPlan")(function* (ctx: {
      readonly params: { readonly workflowID: string }
      readonly payload: { readonly base?: string; readonly dry_run?: boolean }
    }) {
      const instance = yield* InstanceRef
      if (!instance) return yield* new HttpApiError.BadRequest({})
      return yield* asBadRequest(workflow.submitPlan({
        directory: directoryFromRef(instance),
        workflowID: ctx.params.workflowID,
        base: ctx.payload.base,
        dryRun: ctx.payload.dry_run,
      }))
    })

    const syncGithub = Effect.fn("WorkflowHttpApi.syncGithub")(function* (ctx: {
      readonly params: { readonly workflowID: string }
    }) {
      const instance = yield* InstanceRef
      if (!instance) return yield* new HttpApiError.BadRequest({})
      return yield* asBadRequest(workflow.syncGithub({
        directory: directoryFromRef(instance),
        workflowID: ctx.params.workflowID,
      }))
    })

    const revisePlan = Effect.fn("WorkflowHttpApi.revisePlan")(function* (ctx: {
      readonly params: { readonly workflowID: string }
      readonly payload: { readonly instruction?: string; readonly github_comment_url?: string }
    }) {
      const instance = yield* InstanceRef
      if (!instance) return yield* new HttpApiError.BadRequest({})
      return yield* asBadRequest(workflow.revisePlan({
        directory: directoryFromRef(instance),
        workflowID: ctx.params.workflowID,
        instruction: ctx.payload.instruction,
        githubCommentUrl: ctx.payload.github_comment_url,
      }))
    })

    const run = Effect.fn("WorkflowHttpApi.run")(function* (ctx: {
      readonly params: { readonly workflowID: string }
    }) {
      const instance = yield* InstanceRef
      if (!instance) return yield* new HttpApiError.BadRequest({})
      return yield* asBadRequest(workflow.run({
        directory: directoryFromRef(instance),
        workflowID: ctx.params.workflowID,
      }))
    })

    const submitCode = Effect.fn("WorkflowHttpApi.submitCode")(function* (ctx: {
      readonly params: { readonly workflowID: string }
      readonly payload: { readonly base?: string; readonly dry_run?: boolean }
    }) {
      const instance = yield* InstanceRef
      if (!instance) return yield* new HttpApiError.BadRequest({})
      return yield* asBadRequest(workflow.submitCode({
        directory: directoryFromRef(instance),
        workflowID: ctx.params.workflowID,
        base: ctx.payload.base,
        dryRun: ctx.payload.dry_run,
      }))
    })

    const pause = Effect.fn("WorkflowHttpApi.pause")(function* (ctx: {
      readonly params: { readonly workflowID: string }
    }) {
      const instance = yield* InstanceRef
      if (!instance) return yield* new HttpApiError.BadRequest({})
      return yield* asBadRequest(workflow.pause(directoryFromRef(instance), ctx.params.workflowID))
    })

    const resume = Effect.fn("WorkflowHttpApi.resume")(function* (ctx: {
      readonly params: { readonly workflowID: string }
    }) {
      const instance = yield* InstanceRef
      if (!instance) return yield* new HttpApiError.BadRequest({})
      return yield* asBadRequest(workflow.resume(directoryFromRef(instance), ctx.params.workflowID))
    })

    const recover = Effect.fn("WorkflowHttpApi.recover")(function* (ctx: {
      readonly params: { readonly workflowID: string }
    }) {
      const instance = yield* InstanceRef
      if (!instance) return yield* new HttpApiError.BadRequest({})
      return yield* asBadRequest(workflow.recover(directoryFromRef(instance), ctx.params.workflowID))
    })

    const sessions = Effect.fn("WorkflowHttpApi.sessions")(function* (ctx: {
      readonly params: { readonly workflowID: string }
    }) {
      const instance = yield* InstanceRef
      if (!instance) return yield* new HttpApiError.BadRequest({})
      return yield* wfSession.listSessions(directoryFromRef(instance), ctx.params.workflowID)
    })

    const getSession = Effect.fn("WorkflowHttpApi.getSession")(function* (ctx: {
      readonly params: { readonly workflowID: string; readonly sessionID: string }
    }) {
      const instance = yield* InstanceRef
      if (!instance) return yield* new HttpApiError.BadRequest({})
      return yield* wfSession.getSession(
        directoryFromRef(instance),
        ctx.params.workflowID,
        ctx.params.sessionID,
      ).pipe(
        Effect.mapError(
          () =>
            new ApiNotFoundError({
              name: "NotFoundError",
              data: { message: `Session not found: ${ctx.params.sessionID}` },
            }),
        ),
      )
    })

    const steer = Effect.fn("WorkflowHttpApi.steer")(function* (ctx: {
      readonly params: { readonly workflowID: string; readonly sessionID: string }
      readonly payload: { readonly instruction: string; readonly github_comment_url?: string }
    }) {
      const instance = yield* InstanceRef
      if (!instance) return yield* new HttpApiError.BadRequest({})
      return yield* asBadRequest(workflow.steer({
        directory: directoryFromRef(instance),
        workflowID: ctx.params.workflowID,
        sessionID: ctx.params.sessionID,
        instruction: ctx.payload.instruction,
        githubCommentUrl: ctx.payload.github_comment_url,
      }))
    })

    const amendmentApprove = Effect.fn("WorkflowHttpApi.amendmentApprove")(function* (ctx: {
      readonly params: { readonly workflowID: string }
      readonly payload: { readonly approve: boolean; readonly reason?: string }
    }) {
      const instance = yield* InstanceRef
      if (!instance) return yield* new HttpApiError.BadRequest({})
      return yield* asBadRequest(workflow.processAmendment({
        directory: directoryFromRef(instance),
        workflowID: ctx.params.workflowID,
        approve: ctx.payload.approve,
        reason: ctx.payload.reason,
      }))
    })

    return handlers
      .handle("list", list as any)
      .handle("create", create as any)
      .handle("get", get as any)
      .handle("submitPlan", submitPlan as any)
      .handle("syncGithub", syncGithub as any)
      .handle("revisePlan", revisePlan as any)
      .handle("run", run as any)
      .handle("submitCode", submitCode as any)
      .handle("pause", pause as any)
      .handle("resume", resume as any)
      .handle("recover", recover as any)
      .handle("sessions", sessions as any)
      .handle("getSession", getSession as any)
      .handle("steer", steer as any)
      .handle("amendmentApprove", amendmentApprove as any)
  }),
)
