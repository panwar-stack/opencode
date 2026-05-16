import { beforeEach, describe, expect } from "bun:test"
import { AppProcess } from "@opencode-ai/core/process"
import { Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Memory } from "@/memory"
import { MemoryGithub } from "@/memory/github"
import { MemoryCitationTable, MemorySourceItemTable, MemorySyncCheckpointTable } from "@/memory/memory.sql"
import { MemoryIndex } from "@/memory/repo"
import { Database } from "@/storage/db"
import { testEffect } from "../lib/effect"

const it = testEffect(Memory.defaultLayer)
const encoder = new TextEncoder()

beforeEach(async () => {
  await Effect.runPromise(MemoryIndex.clear())
})

describe("GitHub memory index provider", () => {
  it.effect("normalizes review comments into constraints and checkpoints", () =>
    Effect.gen(function* () {
      const result = yield* MemoryGithub.indexComments({
        repo: "opencode/opencode",
        since: "2026-05-01T00:00:00Z",
        comments: [
          {
            id: 1,
            node_id: "PRRC_kwDO1",
            body: "> quoted diff\nPrefer Effect FileSystem over raw fs/promises inside Effect services.",
            html_url: "https://github.com/opencode/opencode/pull/123#discussion_r1",
            pull_request_url: "https://api.github.com/repos/opencode/opencode/pulls/123",
            path: "src/memory/github.ts",
            line: 42,
            position: 7,
            created_at: "2026-05-01T00:00:00Z",
            updated_at: "2026-05-02T00:00:00Z",
            author_association: "MEMBER",
            user: { login: "reviewer" },
          },
          {
            id: 2,
            body: "",
            html_url: "https://github.com/opencode/opencode/pull/123#discussion_r2",
            updated_at: "2026-05-03T00:00:00Z",
          },
        ],
      })

      expect(result).toEqual({
        provider: "github",
        repo: "opencode/opencode",
        fetched: 2,
        indexed: 1,
        cursor: "2026-05-03T00:00:00Z",
      })

      const memory = yield* Memory.Service
      const results = yield* memory.query({ text: "filesystem", repo: "opencode/opencode" })
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({
        provider: "github",
        repo: "opencode/opencode",
        title: "Prefer Effect FileSystem over raw fs/promises inside Effect services.",
        body: "Prefer Effect FileSystem over raw fs/promises inside Effect services.",
        file: "src/memory/github.ts",
        files: ["src/memory/github.ts"],
        confidence: 0.75,
        citations: [{ label: "PR #123 review comment", url: "https://github.com/opencode/opencode/pull/123#discussion_r1" }],
      })
      expect(Database.use((db) => db.select().from(MemorySourceItemTable).all())).toMatchObject([
        {
          provider: "github",
          source_id: "PRRC_kwDO1",
          source_kind: "review_comment",
          pr_number: 123,
          author: "reviewer",
          path: "src/memory/github.ts",
          line: 42,
          position: 7,
          source_cursor: "2026-05-02T00:00:00Z",
        },
      ])
      expect(Database.use((db) => db.select().from(MemoryCitationTable).all())).toHaveLength(1)
      expect(Database.use((db) => db.select().from(MemorySyncCheckpointTable).all())).toMatchObject([
        {
          provider: "github",
          repo: "opencode/opencode",
          cursor: "2026-05-03T00:00:00Z",
          fetch_options: { since: "2026-05-01T00:00:00Z" },
        },
      ])
    }),
  )

  it.effect("dedupes repeated deterministic constraints and keeps every file queryable", () =>
    Effect.gen(function* () {
      yield* MemoryGithub.indexComments({
        repo: "opencode/opencode",
        comments: [
          {
            id: 1,
            body: "Keep CLI output compact.",
            html_url: "https://github.com/opencode/opencode/pull/1#discussion_r1",
            pull_request_url: "https://api.github.com/repos/opencode/opencode/pulls/1",
            path: "src/cli/cmd/memory.ts",
            updated_at: "2026-05-01T00:00:00Z",
          },
          {
            id: 2,
            body: "Keep CLI output compact.",
            html_url: "https://github.com/opencode/opencode/pull/2#discussion_r2",
            pull_request_url: "https://api.github.com/repos/opencode/opencode/pulls/2",
            path: "src/cli/cmd/github.ts",
            updated_at: "2026-05-02T00:00:00Z",
          },
        ],
      })

      const memory = yield* Memory.Service
      expect(yield* memory.query({ text: "compact", repo: "opencode/opencode" })).toHaveLength(1)
      expect(yield* memory.query({ text: "compact", file: "src/cli/cmd/memory.ts" })).toHaveLength(1)
      expect(yield* memory.query({ text: "compact", file: "src/cli/cmd/github.ts" })).toHaveLength(1)
      expect(Database.use((db) => db.select().from(MemorySourceItemTable).all())).toHaveLength(2)
      expect(Database.use((db) => db.select().from(MemoryCitationTable).all())).toHaveLength(2)
    }),
  )

  it.effect("fetches through gh with stored checkpoints and preserves an empty incremental cursor", () =>
    Effect.gen(function* () {
      const calls: string[][] = []
      yield* MemoryIndex.upsertSyncCheckpoint({
        provider: "github",
        repo: "opencode/opencode",
        cursor: "2026-05-01T00:00:00Z",
      })

      const result = yield* MemoryGithub.index({ repo: "opencode/opencode" }).pipe(
        Effect.provide(mockGhLayer((cmd, args) => {
          calls.push([cmd, ...args])
          return "[]"
        })),
      )

      expect(result).toEqual({
        provider: "github",
        repo: "opencode/opencode",
        fetched: 0,
        indexed: 0,
        cursor: "2026-05-01T00:00:00Z",
      })
      expect(calls).toEqual([
        [
          "gh",
          "api",
          "-X",
          "GET",
          "repos/opencode/opencode/pulls/comments",
          "-f",
          "sort=updated",
          "-f",
          "direction=asc",
          "-f",
          "per_page=100",
          "-f",
          "page=1",
          "-f",
          "since=2026-05-01T00:00:00Z",
        ],
      ])
      expect(Database.use((db) => db.select().from(MemorySyncCheckpointTable).all())).toMatchObject([
        {
          provider: "github",
          repo: "opencode/opencode",
          cursor: "2026-05-01T00:00:00Z",
          fetch_options: { since: "2026-05-01T00:00:00Z" },
        },
      ])
    }),
  )

  it.effect("parses GitHub review comment JSON", () =>
    Effect.sync(() => {
      expect(MemoryGithub.parseReviewComments(JSON.stringify([{ id: 1 }, { id: "bad" }]))).toEqual([{ id: 1 }])
      expect(MemoryGithub.parseReviewComments(JSON.stringify({ id: 1 }))).toEqual([])
    }),
  )
})

function mockGhLayer(handler: (cmd: string, args: readonly string[]) => string) {
  return AppProcess.layer.pipe(
    Layer.provide(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          const std = ChildProcess.isStandardCommand(command) ? command : undefined
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(0),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as never,
              stdout: Stream.make(encoder.encode(handler(std?.command ?? "", std?.args ?? []))),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as never,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            }),
          )
        }),
      ),
    ),
  )
}
