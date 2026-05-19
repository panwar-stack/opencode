import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { LSP } from "@/lsp/lsp"
import { Permission } from "../../src/permission"
import { ProjectID } from "../../src/project/schema"
import { MessageID, SessionID, SessionRootID } from "../../src/session/schema"
import { Session } from "@/session/session"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { LspTool } from "../../src/tool/lsp"
import { disposeAllInstances, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const workspaceSymbolQueries: string[] = []
const lspRoots: Array<LSP.FileRoot | undefined> = []

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: (_file, root) =>
      Effect.sync(() => {
        lspRoots.push(root)
        return true
      }),
    touchFile: (_file, _diagnostics, root) =>
      Effect.sync(() => {
        lspRoots.push(root)
      }),
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed([]),
    definition: (_input, root) =>
      Effect.sync(() => {
        lspRoots.push(root)
        return []
      }),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: (query) =>
      Effect.sync(() => {
        workspaceSymbolQueries.push(query)
        return []
      }),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    lsp,
  ),
)

const init = Effect.fn("LspToolTest.init")(function* () {
  const info = yield* LspTool
  return yield* info.init()
})

const run = Effect.fn("LspToolTest.run")(function* (
  args: Tool.InferParameters<typeof LspTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const put = Effect.fn("LspToolTest.put")(function* (file: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(file, "export const x = 1\n")
})

const asks = () => {
  const items: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    },
  }
}

describe("tool.lsp", () => {
  describe("permission metadata", () => {
    it.live("keeps cursor details for position-based operations", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const file = path.join(dir, "test.ts")
            yield* put(file)

            const { items, next } = asks()
            const result = yield* run({ operation: "goToDefinition", filePath: file, line: 3, character: 7 }, next)
            const req = items.find((item) => item.permission === "lsp")

            expect(req).toBeDefined()
            expect(req!.metadata).toEqual({
              operation: "goToDefinition",
              filePath: file,
              line: 3,
              character: 7,
            })
            expect(result.title).toBe("goToDefinition test.ts:3:7")
          }),
        { git: true },
      ),
    )

    it.live("omits cursor details for documentSymbol", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const file = path.join(dir, "test.ts")
            yield* put(file)

            const { items, next } = asks()
            const result = yield* run({ operation: "documentSymbol", filePath: file, line: 3, character: 7 }, next)
            const req = items.find((item) => item.permission === "lsp")

            expect(req).toBeDefined()
            expect(req!.metadata).toEqual({
              operation: "documentSymbol",
              filePath: file,
            })
            expect(result.title).toBe("documentSymbol test.ts")
          }),
        { git: true },
      ),
    )

    it.live("omits file and cursor details for workspaceSymbol", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            workspaceSymbolQueries.length = 0
            const file = path.join(dir, "test.ts")
            yield* put(file)

            const { items, next } = asks()
            const result = yield* run({ operation: "workspaceSymbol", filePath: file, line: 3, character: 7 }, next)
            const req = items.find((item) => item.permission === "lsp")

            expect(req).toBeDefined()
            expect(req!.metadata).toEqual({
              operation: "workspaceSymbol",
            })
            expect(result.title).toBe("workspaceSymbol")
          }),
        { git: true },
      ),
    )

    it.live("passes workspaceSymbol query to LSP", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            workspaceSymbolQueries.length = 0
            const file = path.join(dir, "test.ts")
            yield* put(file)

            yield* run({ operation: "workspaceSymbol", filePath: file, line: 3, character: 7, query: "TestSymbol" })
            yield* run({ operation: "workspaceSymbol", filePath: file, line: 3, character: 7 })

            expect(workspaceSymbolQueries).toEqual(["TestSymbol", ""])
          }),
        { git: true },
      ),
    )

    it.live("uses registered secondary root for LSP ownership", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const secondary = yield* tmpdirScoped({ git: true })
            const file = path.join(secondary, "test.ts")
            yield* put(file)

            lspRoots.length = 0
            const { items, next } = asks()
            const result = yield* run({ operation: "goToDefinition", filePath: file, line: 1, character: 1 }, next).pipe(
              Effect.provide(
                Layer.mock(Session.Service)({
                  listRoots: () =>
                    Effect.succeed([
                      {
                        id: SessionRootID.make("sesroot_primary"),
                        sessionID: ctx.sessionID,
                        directory: dir,
                        worktree: dir,
                        projectID: ProjectID.make("proj_primary"),
                        created: 1,
                        primary: true,
                      },
                      {
                        id: SessionRootID.make("sesroot_secondary"),
                        sessionID: ctx.sessionID,
                        directory: secondary,
                        worktree: secondary,
                        projectID: ProjectID.make("proj_secondary"),
                        created: 2,
                        primary: false,
                      },
                    ]),
                }),
              ),
            )

            expect(result.title).toBe("goToDefinition test.ts:1:1")
            expect(items.some((item) => item.permission === "external_directory")).toBe(false)
            expect(lspRoots.some((root) => root?.directory === secondary && root.worktree === secondary)).toBe(true)
          }),
        { git: true },
      ),
    )
  })
})
