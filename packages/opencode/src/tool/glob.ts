import path from "path"
import { Effect, Option, Schema } from "effect"
import * as Stream from "effect/Stream"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Ripgrep } from "../file/ripgrep"
import { assertExternalDirectoryWithSession } from "./external-directory"
import DESCRIPTION from "./glob.txt"
import * as Tool from "./tool"
import { Reference } from "@/reference/reference"
import { ToolPath } from "./path"
import { Session } from "@/session/session"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The glob pattern to match files against" }),
  path: Schema.optional(Schema.String).annotate({
    description: `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
  }),
})

export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const rg = yield* Ripgrep.Service
    const fs = yield* AppFileSystem.Service
    const reference = yield* Reference.Service
    const session = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "glob",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
            },
          })

          const resolved = yield* ToolPath.resolveWithSession(session, ctx, params.path)
          const search = resolved.path
          yield* reference.ensure(search)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (info?.type === "File") {
            throw new Error(`glob path must be a directory: ${search}`)
          }
          yield* assertExternalDirectoryWithSession(session, ctx, search, {
            bypass: yield* reference.contains(search),
            kind: "directory",
          })

          const limit = 100
          let truncated = false
          const files = yield* rg.files({ cwd: search, glob: [params.pattern], signal: ctx.abort }).pipe(
            Stream.mapEffect((file) =>
              Effect.gen(function* () {
                const full = path.resolve(search, file)
                const info = yield* fs.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
                const mtime =
                  info?.mtime.pipe(
                    Option.map((date) => date.getTime()),
                    Option.getOrElse(() => 0),
                  ) ?? 0
                return { path: full, mtime }
              }),
            ),
            Stream.take(limit + 1),
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          )

          if (files.length > limit) {
            truncated = true
            files.length = limit
          }
          files.sort((a, b) => b.mtime - a.mtime)

          const output = []
          if (files.length === 0) output.push("No files found")
          if (files.length > 0) {
            output.push(...files.map((file) => file.path))
            if (truncated) {
              output.push("")
              output.push(
                `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`,
              )
            }
          }

          return {
            title: resolved.relative,
            metadata: {
              count: files.length,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
