import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Memory } from "@/memory/memory"
import { RepositoryMemoryFileSummaryTable } from "@/memory/memory.sql"
import { Database } from "@/storage/db"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffect(Layer.mergeAll(Memory.defaultLayer))

describe("Memory file summaries", () => {
  it.live("generates searchable summaries for top active files", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      yield* Effect.promise(() =>
        createCommit(tmp.path, "src/auth.ts", "export const loginRedirect = true\n", "fix login redirect"),
      )
      yield* Effect.promise(() =>
        createCommit(tmp.path, "src/catalog.ts", "export const catalog = true\n", "add catalog"),
      )
      yield* Effect.promise(() =>
        createCommit(tmp.path, "src/auth.ts", "export const loginRedirect = 'fixed'\n", "update login redirect"),
      )

      const memory = yield* Memory.Service
      const result = yield* memory.indexLocalRepository({
        worktree: tmp.path,
        maxCommits: 10,
        noGithub: true,
        summaries: 1,
        summaryGenerator: summaryGenerator("Login redirect responsibility", ["loginRedirect"]),
      })
      const matches = yield* memory.searchSummaryRows({ repository_id: result.repository.id, query: "redirect" })
      const summary = yield* memory.getFileSummary({
        repository_id: result.repository.id,
        path: "src/auth.ts",
        worktree: tmp.path,
      })

      expect(result.summaries).toMatchObject({ requested: 1, generated: 1, reused: 0, failed: 0 })
      expect(matches[0].path).toBe("src/auth.ts")
      expect(matches[0].summary).toBe("Login redirect responsibility")
      expect(JSON.parse(matches[0].important_symbols)).toEqual(["loginRedirect"])
      expect(summary?.stale).toBe(false)
      expect(summary?.missing).toBe(false)
    }),
  )

  it.live("reuses unchanged summaries and refreshes changed source hashes", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      yield* Effect.promise(() =>
        createCommit(tmp.path, "src/auth.ts", "export const loginRedirect = true\n", "fix login redirect"),
      )
      const memory = yield* Memory.Service
      const first = yield* memory.indexLocalRepository({
        worktree: tmp.path,
        maxCommits: 10,
        noGithub: true,
        summaries: 1,
        summaryGenerator: summaryGenerator("first summary", ["loginRedirect"]),
      })
      const reused = yield* memory.generateFileSummaries({
        repository_id: first.repository.id,
        worktree: tmp.path,
        limit: 1,
        generator: summaryGenerator("unused summary", ["unused"]),
      })
      const before = Database.use((db) =>
        db
          .select()
          .from(RepositoryMemoryFileSummaryTable)
          .where(eq(RepositoryMemoryFileSummaryTable.repository_id, first.repository.id))
          .get(),
      )

      yield* Effect.promise(() =>
        Bun.write(path.join(tmp.path, "src/auth.ts"), "export const loginRedirect = 'changed'\n"),
      )
      const refreshed = yield* memory.generateFileSummaries({
        repository_id: first.repository.id,
        worktree: tmp.path,
        limit: 1,
        generator: summaryGenerator("refreshed summary", ["loginRedirect"]),
      })
      const after = Database.use((db) =>
        db
          .select()
          .from(RepositoryMemoryFileSummaryTable)
          .where(eq(RepositoryMemoryFileSummaryTable.repository_id, first.repository.id))
          .get(),
      )

      expect(first.summaries.generated).toBe(1)
      expect(reused).toMatchObject({ requested: 1, generated: 0, reused: 1, failed: 0 })
      expect(refreshed).toMatchObject({ requested: 1, generated: 1, reused: 0, failed: 0 })
      expect(before?.source_hash).not.toBe(after?.source_hash)
      expect(after?.summary).toBe("refreshed summary")
    }),
  )

  it.live("summarizes source from the indexed cutoff window", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      yield* Effect.promise(() =>
        createCommit(
          tmp.path,
          "src/auth.ts",
          "export const loginRedirect = 'historical'\n",
          "fix historical login redirect",
          "2024-01-01T00:00:00Z",
        ),
      )
      yield* Effect.promise(() =>
        createCommit(
          tmp.path,
          "src/auth.ts",
          "export const loginRedirect = 'future'\n",
          "future login redirect",
          "2024-01-02T00:00:00Z",
        ),
      )

      const memory = yield* Memory.Service
      const result = yield* memory.indexLocalRepository({
        worktree: tmp.path,
        maxCommits: 10,
        cutoffTime: "2024-01-02T00:00:00Z",
        noGithub: true,
        summaries: 1,
        summaryGenerator: (input) =>
          Effect.succeed({ summary: input.content, important_symbols: [], model_id: "test/model" }),
      })
      const summary = yield* memory.getFileSummary({ repository_id: result.repository.id, path: "src/auth.ts" })

      expect(result.indexedCommits).toBe(1)
      expect(result.summaries.generated).toBe(1)
      expect(summary?.summary).toContain("historical")
      expect(summary?.summary).not.toContain("future")
    }),
  )

  it.live("removes stale future summaries when cutoff refresh fails", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      yield* Effect.promise(() =>
        createCommit(
          tmp.path,
          "src/auth.ts",
          "export const loginRedirect = 'historical'\n",
          "fix historical login redirect",
          "2024-01-01T00:00:00Z",
        ),
      )
      yield* Effect.promise(() =>
        createCommit(
          tmp.path,
          "src/auth.ts",
          "export const loginRedirect = 'future'\n",
          "future login redirect",
          "2024-01-02T00:00:00Z",
        ),
      )

      const memory = yield* Memory.Service
      const full = yield* memory.indexLocalRepository({
        worktree: tmp.path,
        maxCommits: 10,
        noGithub: true,
        summaries: 1,
        summaryGenerator: (input) =>
          Effect.succeed({ summary: input.content, important_symbols: [], model_id: "test/model" }),
      })
      const futureMatches = yield* memory.searchSummaryRows({ repository_id: full.repository.id, query: "future" })
      const narrowed = yield* memory.indexLocalRepository({
        worktree: tmp.path,
        maxCommits: 10,
        cutoffTime: "2024-01-02T00:00:00Z",
        noGithub: true,
        summaries: 1,
        summaryGenerator: () => Effect.fail(new Error("summary unavailable")),
      })
      const staleMatches = yield* memory.searchSummaryRows({ repository_id: narrowed.repository.id, query: "future" })
      const commitMatches = yield* memory.searchCommitRows({
        repository_id: narrowed.repository.id,
        query: "historical login redirect",
      })

      expect(futureMatches).toHaveLength(1)
      expect(narrowed.summaries).toMatchObject({ requested: 1, generated: 0, reused: 0, failed: 1 })
      expect(staleMatches).toEqual([])
      expect(commitMatches[0].message).toBe("fix historical login redirect")
    }),
  )

  it.live("reports summary failures without breaking commit memory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      yield* Effect.promise(() =>
        createCommit(tmp.path, "src/auth.ts", "export const loginRedirect = true\n", "fix login redirect"),
      )

      const memory = yield* Memory.Service
      const result = yield* memory.indexLocalRepository({
        worktree: tmp.path,
        maxCommits: 10,
        noGithub: true,
        summaries: 1,
        summaryGenerator: () => Effect.fail(new Error("summary service unavailable")),
      })
      const matches = yield* memory.searchCommitRows({ repository_id: result.repository.id, query: "login redirect" })

      expect(result.summaries).toMatchObject({ requested: 1, generated: 0, reused: 0, failed: 1 })
      expect(result.summaries.failures[0]).toEqual({ path: "src/auth.ts", message: "summary service unavailable" })
      expect(matches[0].message).toBe("fix login redirect")
    }),
  )

  it.live("omits summary progress when summary indexing is disabled", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      yield* Effect.promise(() =>
        createCommit(tmp.path, "src/auth.ts", "export const loginRedirect = true\n", "fix login redirect"),
      )

      const progress: Memory.IndexProgress[] = []
      const memory = yield* Memory.Service
      yield* memory.indexLocalRepository({
        worktree: tmp.path,
        maxCommits: 10,
        noGithub: true,
        summaries: 0,
        onProgress: (event) =>
          Effect.sync(() => {
            progress.push(event)
          }),
      })

      expect(progress).toEqual([
        { phase: "resolve" },
        { phase: "crawl", current: 0, total: 2 },
        { phase: "crawl", current: 1, total: 2 },
        { phase: "crawl", current: 2, total: 2 },
        { phase: "store", indexed: 1, skipped: 1 },
        { phase: "activity" },
      ])
    }),
  )
})

function summaryGenerator(summary: string, important_symbols: readonly string[]): Memory.SummaryGenerator {
  return () => Effect.succeed({ summary, important_symbols, model_id: "test/model" })
}

async function createCommit(dir: string, file: string, content: string, message: string, date?: string) {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
  await Bun.write(path.join(dir, file), content)
  await $`git add ${file}`.cwd(dir).quiet()
  if (date) {
    const commit = Bun.spawn(["git", "commit", "--date", date, "-m", message], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      stdout: "ignore",
      stderr: "ignore",
    })
    if ((await commit.exited) !== 0) throw new Error("git commit failed")
    return
  }
  await $`git commit -m ${message}`.cwd(dir).quiet()
}
