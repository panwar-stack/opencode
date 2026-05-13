import path from "path"
import { Effect } from "effect"
import type * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { WorkflowArtifact } from "@/workflow/artifact"
import { WorkflowScope } from "@/workflow/scope"
import { makeRuntime } from "@/effect/run-service"

const { runPromise } = makeRuntime(WorkflowScope.Service, WorkflowScope.defaultLayer)

const workflowDirectory = Effect.fn("Tool.workflowDirectory")(function* (fallback: string, files: readonly string[]) {
  const candidates = [
    ...files.flatMap((file) => {
      const parts = path.resolve(file).split(path.sep)
      return parts.map((_, index) => parts.slice(0, parts.length - index).join(path.sep) || path.sep)
    }),
    fallback,
  ].filter((item, index, list) => list.indexOf(item) === index)
  for (const candidate of candidates) {
    const workflows = yield* Effect.promise(() => WorkflowArtifact.list(candidate)).pipe(Effect.catch(() => Effect.succeed([] as readonly string[])))
    if (workflows.length > 0) return candidate
  }
  return fallback
})

export const assertWorkflowScope = Effect.fn("Tool.assertWorkflowScope")(function* (
  ctx: Tool.Context,
  files: readonly string[],
) {
  const instance = yield* InstanceState.context
  const directory = yield* workflowDirectory(instance.worktree, files)
  const workflowIDs = yield* Effect.promise(() => WorkflowArtifact.list(directory)).pipe(Effect.catch(() => Effect.succeed([] as readonly string[])))
  const states = yield* Effect.all(
    workflowIDs.map((workflowID) => Effect.promise(() => WorkflowArtifact.readState(directory, workflowID)).pipe(Effect.catch(() => Effect.succeed(undefined)))),
    { concurrency: "unbounded" },
  )
  const state = states.find((item) => item?.sessions.some((session) => session.id === String(ctx.sessionID)))
  const session = state?.sessions.find((item) => item.id === String(ctx.sessionID))
  if (!state || (session?.role !== "executor" && session?.role !== "amendment")) return

  const relative = files.map((file) => path.relative(directory, file).replaceAll("\\", "/"))
  const existing = yield* Effect.all(
    files.map((file, index) =>
      Effect.promise(() => Bun.file(file).exists()).pipe(Effect.map((exists) => (exists ? relative[index] : undefined))),
    ),
    { concurrency: "unbounded" },
  )
  const result = yield* Effect.promise(() =>
    runPromise((scope) =>
      scope.checkEdit(
        directory,
        state.workflow_id,
        relative,
        existing.filter((file): file is string => file !== undefined),
      ),
    ),
  )
  if (result.allowed) return
  return yield* Effect.fail(new Error(`Workflow scope denied edit: ${result.reason}`))
})
