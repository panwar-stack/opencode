import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@/storage/db"
import { Memory } from "@/memory/memory"
import {
  RepositoryMemoryCommitTable,
  RepositoryMemoryFileActivityTable,
  RepositoryMemoryRepositoryTable,
  RepositoryMemoryFileSummaryTable,
  RepositoryMemoryRetrievalLogTable,
} from "@/memory/memory.sql"
import { tokenText } from "@/memory/search"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Memory.defaultLayer))

describe("Memory service", () => {
  it.live("normalizes repository identity and exposes schema tables", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const normalized = yield* memory.identity("https://github.com/opencode-ai/opencode.git")

      expect(normalized).toEqual({
        identity: "github.com/opencode-ai/opencode",
        provider: "github",
        owner: "opencode-ai",
        name: "opencode",
      })
      expect(memory.tables.repository).toBe(RepositoryMemoryRepositoryTable)
      expect(memory.tables.commit).toBe(RepositoryMemoryCommitTable)
      expect(memory.tables.fileActivity).toBe(RepositoryMemoryFileActivityTable)
      expect(memory.tables.fileSummary).toBe(RepositoryMemoryFileSummaryTable)
      expect(memory.tables.retrievalLog).toBe(RepositoryMemoryRetrievalLogTable)
    }),
  )

  it.live("upserts repositories and searches scoped token_text", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const repository = yield* memory.ensureRepository({ reference: "github:opencode-ai/opencode", default_branch: "dev" })
      const now = Date.now()

      Database.use((db) => {
        db.insert(RepositoryMemoryCommitTable)
          .values([
            {
              id: "commit-1",
              repository_id: repository.id,
              hash: "abc123",
              message: "Fix parseRepositoryReference",
              author_time: now,
              changed_files: JSON.stringify(["src/util/repository.ts"]),
              diff: "diff",
              token_text: tokenText("Fix parseRepositoryReference src/util/repository.ts"),
              time_created: now,
              time_updated: now,
            },
            {
              id: "commit-2",
              repository_id: repository.id,
              hash: "def456",
              message: "Update theme",
              author_time: now - 1,
              changed_files: JSON.stringify(["src/theme.ts"]),
              diff: "diff",
              token_text: tokenText("Update theme colors"),
              time_created: now,
              time_updated: now,
            },
          ])
          .run()
        db.insert(RepositoryMemoryFileSummaryTable)
          .values({
            id: "summary-1",
            repository_id: repository.id,
            path: "src/util/repository.ts",
            source_hash: "abc123",
            summary: "Repository identity helpers",
            important_symbols: JSON.stringify(["parseRepositoryReference"]),
            token_text: tokenText("parseRepositoryReference repositoryCacheIdentity src/util/repository.ts"),
            time_generated: now,
            time_created: now,
            time_updated: now,
          })
          .run()
      })

      const stored = Database.use((db) =>
        db.select().from(RepositoryMemoryRepositoryTable).where(eq(RepositoryMemoryRepositoryTable.id, repository.id)).get(),
      )
      const commits = yield* memory.searchCommits({ repository_id: repository.id, query: "parseRepositoryReference" })
      const summaries = yield* memory.searchSummaries({ repository_id: repository.id, query: "src/util/repository.ts" })

      expect(stored?.identity).toBe("github.com/opencode-ai/opencode")
      expect(stored?.default_branch).toBe("dev")
      expect(commits[0].id).toBe("commit-1")
      expect(commits[0].strength).toBe("strong")
      expect(summaries[0].id).toBe("summary-1")
      expect(summaries[0].exact_file_path_match).toBe(true)
    }),
  )

  it.live("bounds search corpus by recency before ranking", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const now = Date.now()
      const prefix = crypto.randomUUID()
      const repository = yield* memory.ensureRepository({ reference: `github:opencode-ai/${prefix}` })

      Database.use((db) => {
        Array.from({ length: Math.ceil(7_001 / 400) }, (_, chunk) => chunk * 400).forEach((offset) => {
          db.insert(RepositoryMemoryCommitTable)
            .values(
              Array.from({ length: Math.min(400, 7_001 - offset) }, (_, chunkIndex) => {
                const index = offset + chunkIndex
                return {
                  id: `${prefix}-commit-${index}`,
                  repository_id: repository.id,
                  hash: `${prefix}-hash-${index}`,
                  message: index === 0 ? "old commit needle" : "recent commit",
                  author_time: now - (7_001 - index),
                  changed_files: JSON.stringify(["src/file.ts"]),
                  diff: "diff",
                  token_text: tokenText(index === 0 ? "old commit needle" : "recent commit"),
                  time_created: now,
                  time_updated: now,
                }
              }),
            )
            .run()
        })
        db.insert(RepositoryMemoryFileSummaryTable)
          .values(
            Array.from({ length: 201 }, (_, index) => ({
              id: `${prefix}-summary-${index}`,
              repository_id: repository.id,
              path: `src/file-${index}.ts`,
              source_hash: `${prefix}-hash-${index}`,
              summary: index === 0 ? "old summary needle" : "recent summary",
              important_symbols: JSON.stringify([]),
              token_text: tokenText(index === 0 ? "old summary needle" : "recent summary"),
              time_generated: now - (201 - index),
              time_created: now,
              time_updated: now,
            })),
          )
          .run()
      })

      expect(yield* memory.searchCommits({ repository_id: repository.id, query: "needle" })).toEqual([])
      expect(yield* memory.searchSummaries({ repository_id: repository.id, query: "needle" })).toEqual([])
    }),
  )
})
