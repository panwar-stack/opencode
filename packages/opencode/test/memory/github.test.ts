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
type MockGhResponse = string | { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number }

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
      }).pipe(Effect.provide(mockGhLayer(() => ({ exitCode: 1 }))))

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

  it.effect("stores pull request metadata for review comments once per unique PR", () =>
    Effect.gen(function* () {
      const calls: string[][] = []
      yield* MemoryGithub.indexComments({
        repo: "opencode/opencode",
        comments: [
          {
            id: 1,
            node_id: "PRRC_kwDO1",
            body: "Prefer tiny review memories.",
            html_url: "https://github.com/opencode/opencode/pull/123#discussion_r1",
            pull_request_url: "https://api.github.com/repos/opencode/opencode/pulls/123",
            updated_at: "2026-05-02T00:00:00Z",
          },
          {
            id: 2,
            node_id: "PRRC_kwDO2",
            body: "Use the same PR metadata.",
            html_url: "https://github.com/opencode/opencode/pull/123#discussion_r2",
            pull_request_url: "https://api.github.com/repos/opencode/opencode/pulls/123",
            updated_at: "2026-05-03T00:00:00Z",
          },
        ],
      }).pipe(
        Effect.provide(mockGhLayer((cmd, args) => {
          calls.push([cmd, ...args])
          return JSON.stringify({
            number: 123,
            title: "Index PR state",
            state: "closed",
            merged: true,
            closed_at: "2026-05-01T00:00:00Z",
            merged_at: "2026-05-01T00:00:00Z",
            base: { ref: "dev" },
            head: { ref: "review-memory", sha: "abc123" },
          })
        })),
      )

      expect(calls).toEqual([["gh", "api", "repos/opencode/opencode/pulls/123"]])
      expect(Database.use((db) => db.select().from(MemorySourceItemTable).all()).map((row) => row.metadata)).toEqual([
        {
          pr: {
            number: 123,
            title: "Index PR state",
            state: "closed",
            merged: true,
            closed_at: "2026-05-01T00:00:00Z",
            merged_at: "2026-05-01T00:00:00Z",
            base_ref: "dev",
            head_ref: "review-memory",
            head_sha: "abc123",
          },
        },
        {
          pr: {
            number: 123,
            title: "Index PR state",
            state: "closed",
            merged: true,
            closed_at: "2026-05-01T00:00:00Z",
            merged_at: "2026-05-01T00:00:00Z",
            base_ref: "dev",
            head_ref: "review-memory",
            head_sha: "abc123",
          },
        },
      ])
    }),
  )

  it.effect("omits pull request metadata when PR fetch fails", () =>
    Effect.gen(function* () {
      yield* MemoryGithub.indexComments({
        repo: "opencode/opencode",
        comments: [
          {
            id: 1,
            body: "Still index the review memory.",
            html_url: "https://github.com/opencode/opencode/pull/123#discussion_r1",
            pull_request_url: "https://api.github.com/repos/opencode/opencode/pulls/123",
            updated_at: "2026-05-02T00:00:00Z",
          },
        ],
      }).pipe(Effect.provide(mockGhLayer(() => ({ exitCode: 1, stderr: "not found" }))))

      expect(Database.use((db) => db.select().from(MemorySourceItemTable).all()).map((row) => row.metadata)).toEqual([
        {},
      ])
      const memory = yield* Memory.Service
      expect(yield* memory.query({ text: "review memory" })).toHaveLength(1)
    }),
  )

  it.effect("stores closed unmerged pull request metadata without null timestamps", () =>
    Effect.gen(function* () {
      yield* MemoryGithub.indexComments({
        repo: "opencode/opencode",
        comments: [
          {
            id: 1,
            body: "Closed PR memories should still index.",
            html_url: "https://github.com/opencode/opencode/pull/124#discussion_r1",
            pull_request_url: "https://api.github.com/repos/opencode/opencode/pulls/124",
            updated_at: "2026-05-02T00:00:00Z",
          },
        ],
      }).pipe(
        Effect.provide(mockGhLayer(() =>
          JSON.stringify({
            number: 124,
            title: "Close without merge",
            state: "closed",
            merged: false,
            closed_at: "2026-05-01T00:00:00Z",
            merged_at: null,
            base: { ref: "dev" },
            head: { ref: "abandoned", sha: "def456" },
          }),
        )),
      )

      expect(Database.use((db) => db.select().from(MemorySourceItemTable).all()).map((row) => row.metadata)).toEqual([
        {
          pr: {
            number: 124,
            title: "Close without merge",
            state: "closed",
            merged: false,
            closed_at: "2026-05-01T00:00:00Z",
            base_ref: "dev",
            head_ref: "abandoned",
            head_sha: "def456",
          },
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
      }).pipe(Effect.provide(mockGhLayer(() => ({ exitCode: 1 }))))

      const memory = yield* Memory.Service
      expect(yield* memory.query({ text: "compact", repo: "opencode/opencode" })).toHaveLength(1)
      expect(yield* memory.query({ text: "compact", file: "src/cli/cmd/memory.ts" })).toHaveLength(1)
      expect(yield* memory.query({ text: "compact", file: "src/cli/cmd/github.ts" })).toHaveLength(1)
      expect(Database.use((db) => db.select().from(MemorySourceItemTable).all())).toHaveLength(2)
      expect(Database.use((db) => db.select().from(MemoryCitationTable).all())).toHaveLength(2)
    }),
  )

  it.effect("filters GitHub review comments by included and excluded authors", () =>
    Effect.gen(function* () {
      const result = yield* MemoryGithub.indexComments({
        repo: "opencode/opencode",
        include_authors: ["alice", "blocked"],
        exclude_authors: ["bot", "blocked"],
        comments: [
          {
            id: 1,
            body: "Use readiness signals before assertions.",
            html_url: "https://github.com/opencode/opencode/pull/1#discussion_r1",
            pull_request_url: "https://api.github.com/repos/opencode/opencode/pulls/1",
            updated_at: "2026-05-01T00:00:00Z",
            user: { login: "Alice" },
          },
          {
            id: 2,
            body: "Bot comments should not become memory.",
            html_url: "https://github.com/opencode/opencode/pull/1#discussion_r2",
            updated_at: "2026-05-02T00:00:00Z",
            user: { login: "bot" },
          },
          {
            id: 3,
            body: "Excluded authors win over included authors.",
            html_url: "https://github.com/opencode/opencode/pull/1#discussion_r3",
            updated_at: "2026-05-03T00:00:00Z",
            user: { login: "blocked" },
          },
          {
            id: 4,
            body: "Unlisted authors should not become memory.",
            html_url: "https://github.com/opencode/opencode/pull/1#discussion_r4",
            updated_at: "2026-05-04T00:00:00Z",
            user: { login: "carol" },
          },
        ],
      }).pipe(Effect.provide(mockGhLayer(() => ({ exitCode: 1 }))))

      expect(result).toMatchObject({ fetched: 4, indexed: 1, cursor: "2026-05-04T00:00:00Z" })
      expect(Database.use((db) => db.select().from(MemorySourceItemTable).all()).map((row) => row.author)).toEqual([
        "Alice",
      ])
      const memory = yield* Memory.Service
      expect(yield* memory.query({ text: "readiness" })).toHaveLength(1)
      expect(yield* memory.query({ text: "bot comments" })).toHaveLength(0)
    }),
  )

  it.effect("filters GitHub review comments by max age", () =>
    Effect.gen(function* () {
      const result = yield* MemoryGithub.indexComments({
        repo: "opencode/opencode",
        max_age_days: 7,
        comments: [
          {
            id: 1,
            body: "Recent comments should become memory.",
            html_url: "https://github.com/opencode/opencode/pull/1#discussion_r1",
            updated_at: new Date().toISOString(),
          },
          {
            id: 2,
            body: "Old comments should not become memory.",
            html_url: "https://github.com/opencode/opencode/pull/1#discussion_r2",
            updated_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
          },
          {
            id: 3,
            body: "Undated comments should not become memory under max age.",
            html_url: "https://github.com/opencode/opencode/pull/1#discussion_r3",
          },
        ],
      }).pipe(Effect.provide(mockGhLayer(() => ({ exitCode: 1 }))))

      expect(result).toMatchObject({ fetched: 3, indexed: 1 })
      const memory = yield* Memory.Service
      expect(yield* memory.query({ text: "recent" })).toHaveLength(1)
      expect(yield* memory.query({ text: "old" })).toHaveLength(0)
      expect(yield* memory.query({ text: "undated" })).toHaveLength(0)
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

function mockGhLayer(handler: (cmd: string, args: readonly string[]) => MockGhResponse) {
  return AppProcess.layer.pipe(
    Layer.provide(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          const std = ChildProcess.isStandardCommand(command) ? command : undefined
          const response = handler(std?.command ?? "", std?.args ?? [])
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(0),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(typeof response === "string" ? 0 : response.exitCode ?? 0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as never,
              stdout: Stream.make(encoder.encode(typeof response === "string" ? response : response.stdout ?? "")),
              stderr: typeof response === "string" ? Stream.empty : Stream.make(encoder.encode(response.stderr ?? "")),
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
