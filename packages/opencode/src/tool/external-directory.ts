import path from "path"
import { Effect } from "effect"
import * as EffectLogger from "@opencode-ai/core/effect/logger"
import type * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { ToolPath } from "./path"
import { Session } from "@/session/session"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  const session = yield* Session.Service
  yield* assertExternalDirectoryWithSession(session, ctx, target, options)
})

export const assertExternalDirectoryWithSession = Effect.fn("Tool.assertExternalDirectoryWithSession")(function* (
  session: Session.Interface,
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return

  if (options?.bypass) return

  const full = process.platform === "win32" ? AppFileSystem.normalizePath(target) : target
  if (yield* ToolPath.insideWithSession(session, ctx, full)) return

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: full,
      parentDir: dir,
    },
  })
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(
    assertExternalDirectoryEffect(ctx, target, options).pipe(Effect.provide(Session.defaultLayer), Effect.provide(EffectLogger.layer)),
  )
}
