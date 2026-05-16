import { beforeEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { formatQueryJSON } from "@/cli/cmd/memory"
import { Memory } from "@/memory"
import { MemoryIndex } from "@/memory/repo"
import { MemoryCitationTable, MemorySourceItemTable, MemorySyncCheckpointTable } from "@/memory/memory.sql"
import { Database } from "@/storage/db"
import { testEffect } from "../lib/effect"

const it = testEffect(Memory.defaultLayer)

beforeEach(async () => {
  await Effect.runPromise(MemoryIndex.clear())
})

describe("memory index", () => {
  it.effect("inserts, dedupes, queries, and preserves citations", () =>
    Effect.gen(function* () {
      yield* MemoryIndex.upsertConstraint({
        provider: "github",
        repo: "opencode/opencode",
        title: "Use Effect FileSystem",
        text: "Prefer Effect FileSystem over raw fs/promises inside Effect services.",
        confidence: 0.85,
        files: ["src/memory/index.ts"],
        directories: ["src/memory"],
        citations: [{ label: "PR #123", url: "https://github.com/opencode/opencode/pull/123#discussion_r1" }],
        source_items: [
          {
            provider: "github",
            repo: "opencode/opencode",
            source_id: "discussion_r1",
            source_kind: "review_comment",
            pr_number: 123,
            author: "reviewer",
            url: "https://github.com/opencode/opencode/pull/123#discussion_r1",
            path: "src/memory/index.ts",
            line: 42,
            title: "Prefer Effect FileSystem",
            labels: ["review-memory"],
          },
        ],
      })

      yield* MemoryIndex.upsertConstraint({
        provider: "github",
        repo: "opencode/opencode",
        title: "Prefer Effect FileSystem",
        text: "Prefer Effect FileSystem over raw fs/promises inside Effect services.",
        confidence: 0.9,
        files: ["src/memory/index.ts"],
        citations: [{ label: "PR #123", url: "https://github.com/opencode/opencode/pull/123#discussion_r1" }],
        source_items: [
          {
            provider: "github",
            repo: "opencode/opencode",
            source_id: "discussion_r1",
            source_kind: "review_comment",
            author: "reviewer",
            url: "https://github.com/opencode/opencode/pull/123#discussion_r1",
            path: "src/memory/index.ts",
          },
        ],
      })

      const memory = yield* Memory.Service
      const results = yield* memory.query({ text: "filesystem", file: "src/memory/index.ts" })

      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({
        provider: "github",
        repo: "opencode/opencode",
        title: "Prefer Effect FileSystem",
        body: "Prefer Effect FileSystem over raw fs/promises inside Effect services.",
        file: "src/memory/index.ts",
        files: ["src/memory/index.ts"],
        confidence: 0.9,
        citations: [{ label: "PR #123", url: "https://github.com/opencode/opencode/pull/123#discussion_r1" }],
      })
      expect(JSON.parse(formatQueryJSON(results))[0].citations).toEqual([
        { label: "PR #123", url: "https://github.com/opencode/opencode/pull/123#discussion_r1" },
      ])
      expect(Database.use((db) => db.select().from(MemorySourceItemTable).all())).toHaveLength(1)
      expect(Database.use((db) => db.select().from(MemoryCitationTable).all())).toHaveLength(1)
    }),
  )

  it.effect("filters by file and repository and ignores stale constraints", () =>
    Effect.gen(function* () {
      yield* MemoryIndex.upsertConstraint({
        provider: "github",
        repo: "opencode/opencode",
        title: "Compact terminal output",
        text: "Keep terminal review output compact and scannable.",
        confidence: 0.7,
        files: ["src/session/list.ts"],
      })
      yield* MemoryIndex.upsertConstraint({
        provider: "github",
        repo: "opencode/other",
        title: "Other repository terminal output",
        text: "Keep terminal review output compact in the other repository.",
        confidence: 0.7,
        files: ["src/session/list.ts"],
      })
      yield* MemoryIndex.upsertConstraint({
        provider: "github",
        repo: "opencode/opencode",
        title: "Stale terminal output",
        text: "Use the old terminal output layout.",
        status: "stale",
        files: ["src/session/list.ts"],
      })

      const memory = yield* Memory.Service

      expect((yield* memory.query({ text: "terminal", file: "src/session/list.ts" })).map((result) => result.title)).toEqual([
        "Compact terminal output",
        "Other repository terminal output",
      ])
      expect((yield* memory.query({ text: "terminal", repo: "opencode/opencode" })).map((result) => result.title)).toEqual([
        "Compact terminal output",
      ])
      expect(yield* memory.query({ text: "terminal", file: "src/auth/login.ts" })).toEqual([])
    }),
  )

  it.effect("stores sync checkpoints for future incremental providers", () =>
    Effect.gen(function* () {
      yield* MemoryIndex.upsertSyncCheckpoint({
        provider: "github",
        repo: "opencode/opencode",
        cursor: "2026-05-01T00:00:00Z",
        last_fetched_at: 1_779_996_000_000,
        fetch_options: { limit: 100 },
      })

      yield* MemoryIndex.upsertSyncCheckpoint({
        provider: "github",
        repo: "opencode/opencode",
        cursor: "2026-05-02T00:00:00Z",
        last_fetched_at: 1_780_082_400_000,
        fetch_options: { limit: 200 },
      })

      expect(Database.use((db) => db.select().from(MemorySyncCheckpointTable).all())).toMatchObject([
        {
          provider: "github",
          repo: "opencode/opencode",
          cursor: "2026-05-02T00:00:00Z",
          last_fetched_at: 1_780_082_400_000,
          fetch_options: { limit: 200 },
        },
      ])
    }),
  )
})
