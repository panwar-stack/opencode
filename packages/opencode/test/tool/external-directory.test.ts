import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import type { Tool } from "@/tool/tool"
import { assertExternalDirectoryEffect } from "../../src/tool/external-directory"
import { Filesystem } from "@/util/filesystem"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, Session.defaultLayer))

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

function makeCtx() {
  const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    ...baseCtx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx }
}

describe("tool.assertExternalDirectory", () => {
  it.live("no-ops for empty target", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx)

      expect(requests.length).toBe(0)
    }),
  )

  it.live("no-ops for paths inside the instance directory", () =>
    provideInstance("/tmp/project")(
      Effect.gen(function* () {
        const { requests, ctx } = makeCtx()

        yield* assertExternalDirectoryEffect(ctx, path.join("/tmp/project", "file.txt"))

        expect(requests.length).toBe(0)
      }),
    ),
  )

  it.live("asks with a single canonical glob", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      const directory = "/tmp/project"
      const target = "/tmp/outside/file.txt"
      const expected = glob(path.join(path.dirname(target), "*"))

      yield* provideInstance(directory)(assertExternalDirectoryEffect(ctx, target))

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.live("no-ops for paths inside a registered secondary root", () =>
    Effect.gen(function* () {
      const primary = yield* tmpdirScoped({ git: true })
      const secondary = yield* tmpdirScoped({ git: true })
      const { requests, ctx } = makeCtx()

      const info = yield* provideInstance(primary)(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({ title: "tool roots" })
          yield* session.addRoot({ sessionID: info.id, directory: secondary })
          return info
        }),
      )

      yield* provideInstance(primary)(
        assertExternalDirectoryEffect({ ...ctx, sessionID: info.id }, path.join(secondary, "file.txt")),
      )

      expect(requests.find((request) => request.permission === "external_directory")).toBeUndefined()
    }),
  )

  it.live("asks for unregistered siblings in the primary worktree", () =>
    Effect.gen(function* () {
      const repo = yield* tmpdirScoped({ git: true })
      const primary = path.join(repo, "primary")
      const sibling = path.join(repo, "sibling")
      yield* Effect.promise(() => fs.mkdir(primary, { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(sibling, { recursive: true }))
      const { requests, ctx } = makeCtx()

      const info = yield* provideInstance(primary)(
        Effect.gen(function* () {
          const session = yield* Session.Service
          return yield* session.create({ title: "tool roots" })
        }),
      )

      yield* provideInstance(primary)(
        assertExternalDirectoryEffect({ ...ctx, sessionID: info.id }, path.join(sibling, "file.txt")),
      )

      expect(requests.find((request) => request.permission === "external_directory")).toBeDefined()
    }),
  )

  it.live("uses target directory when kind=directory", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      const directory = "/tmp/project"
      const target = "/tmp/outside"
      const expected = glob(path.join(target, "*"))

      yield* provideInstance(directory)(assertExternalDirectoryEffect(ctx, target, { kind: "directory" }))

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.live("skips prompting when bypass=true", () =>
    provideInstance("/tmp/project")(
      Effect.gen(function* () {
        const { requests, ctx } = makeCtx()

        yield* assertExternalDirectoryEffect(ctx, "/tmp/outside/file.txt", { bypass: true })

        expect(requests.length).toBe(0)
      }),
    ),
  )

  if (process.platform === "win32") {
    it.instance(
      "normalizes Windows path variants to one glob",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const outerTmp = yield* tmpdirScoped()
          yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))

          const target = path.join(outerTmp, "outside.txt")
          const alt = target
            .replace(/^[A-Za-z]:/, "")
            .replaceAll("\\", "/")
            .toLowerCase()

          yield* assertExternalDirectoryEffect(ctx, alt)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )

    it.instance(
      "uses drive root glob for root files",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const tmp = yield* TestInstance
          const root = path.parse(tmp.directory).root
          const target = path.join(root, "boot.ini")

          yield* assertExternalDirectoryEffect(ctx, target)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = path.join(root, "*")
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )
  }
})
