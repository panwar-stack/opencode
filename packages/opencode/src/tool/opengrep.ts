import path from "path"
import { Effect, Schema } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Opengrep } from "../file/opengrep"
import { assertExternalDirectoryWithSession } from "./external-directory"
import DESCRIPTION from "./opengrep.txt"
import * as Tool from "./tool"
import { Reference } from "@/reference/reference"
import { ToolPath } from "./path"
import { Session } from "@/session/session"

const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The OpenGrep/Semgrep-compatible pattern to search for" }),
  language: Schema.optional(Schema.String).annotate({ description: "The language to parse. Defaults to generic." }),
  path: Schema.optional(Schema.String).annotate({
    description: "The directory or file to search. Defaults to the current session root.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.ts")',
  }),
  exclude: Schema.optional(Schema.String).annotate({
    description: 'File pattern to exclude from the search (e.g. "test/**")',
  }),
})

export const OpengrepTool = Tool.define(
  "opengrep",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const opengrep = yield* Opengrep.Service
    const reference = yield* Reference.Service
    const session = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.pattern) throw new Error("pattern is required")

          yield* ctx.ask({
            permission: "opengrep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              language: params.language,
              path: params.path,
              include: params.include,
              exclude: params.exclude,
            },
          })

          const resolved = yield* ToolPath.resolveWithSession(session, ctx, params.path)
          const requested = resolved.path
          yield* reference.ensure(requested)
          const requestedInfo = yield* fs.stat(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* assertExternalDirectoryWithSession(session, ctx, requested, {
            bypass: yield* reference.contains(requested),
            kind: requestedInfo?.type === "Directory" ? "directory" : "file",
          })

          const search = AppFileSystem.resolve(requested)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const cwd = info?.type === "Directory" ? search : path.dirname(search)
          const file = info?.type === "Directory" ? undefined : [path.relative(cwd, search)]
          const result = yield* opengrep.search({
            cwd,
            pattern: params.pattern,
            language: params.language,
            include: params.include,
            exclude: params.exclude,
            file,
            signal: ctx.abort,
          })
          const items = result.items.map((item) => ({
            ...item,
            file: AppFileSystem.resolve(path.isAbsolute(item.file) ? item.file : path.join(cwd, item.file)),
          }))

          return {
            title: params.pattern,
            metadata: {
              matches: result.total,
              truncated: result.truncated,
            },
            output: JSON.stringify(items, null, 2),
          }
        }).pipe(Effect.catch((err) => Effect.die(err))),
    }
  }),
)
