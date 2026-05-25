import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Cause, Effect, Exit, Layer } from "effect"
import { Memory } from "@/memory/memory"
import {
  RepositoryMemoryCommitTable,
  RepositoryMemoryFileSummaryTable,
  RepositoryMemoryRetrievalLogTable,
} from "@/memory/memory.sql"
import { Database } from "@/storage/db"
import { tokenText } from "@/memory/search"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffect(Layer.mergeAll(Memory.defaultLayer))

describe("Memory local git indexing", () => {
  it.live("indexes commits and file activity from a local repository", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      yield* Effect.promise(() =>
        createCommit(tmp.path, "src/auth.ts", "export const loginRedirect = true\n", "fix login redirect"),
      )
      yield* Effect.promise(() => createCommit(tmp.path, "bun.lock", "lock\n", "update lockfile"))

      const memory = yield* Memory.Service
      const result = yield* memory.indexLocalRepository({ worktree: tmp.path, maxCommits: 10, noGithub: true })
      const status = yield* memory.status(result.repository.identity)
      const matches = yield* memory.searchCommitRows({ repository_id: result.repository.id, query: "login redirect" })

      expect(result.indexedCommits).toBe(1)
      expect(result.skippedCommits).toBeGreaterThanOrEqual(1)
      expect(status?.commits).toBe(1)
      expect(status?.file_activity).toBe(1)
      expect(matches[0].message).toBe("fix login redirect")
      expect(JSON.parse(matches[0].changed_files)).toEqual(["src/auth.ts"])
    }),
  )

  it.live("emits ordered progress events while indexing local memory", () =>
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
        summaries: 1,
        summaryGenerator: () =>
          Effect.succeed({
            summary: "Login redirect responsibility",
            important_symbols: ["loginRedirect"],
            model_id: "test/model",
          }),
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
        { phase: "summaries", current: 0, total: 1 },
        { phase: "summaries", current: 1, total: 1 },
      ])
    }),
  )

  it.live("replaces repository commit and file activity rows when re-indexing a cutoff window", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      yield* Effect.promise(() =>
        createCommit(
          tmp.path,
          "src/old.ts",
          "export const oldMemory = true\n",
          "add old memory",
          "2024-01-01T00:00:00Z",
        ),
      )
      yield* Effect.promise(() =>
        createCommit(
          tmp.path,
          "src/middle.ts",
          "export const middleMemory = true\n",
          "add middle memory",
          "2024-01-02T00:00:00Z",
        ),
      )
      yield* Effect.promise(() =>
        createCommit(
          tmp.path,
          "src/future.ts",
          "export const futureMemory = true\n",
          "add future memory",
          "2024-01-03T00:00:00Z",
        ),
      )

      const memory = yield* Memory.Service
      const full = yield* memory.indexLocalRepository({ worktree: tmp.path, maxCommits: 10, noGithub: true })
      Database.use((db) => {
        db.insert(RepositoryMemoryFileSummaryTable)
          .values({
            id: crypto.randomUUID(),
            repository_id: full.repository.id,
            path: "src/future.ts",
            source_hash: "summary-source",
            summary: "preserved summary",
            important_symbols: JSON.stringify([]),
            token_text: tokenText("preserved summary futureMemory"),
            time_generated: Date.now(),
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          .run()
        db.insert(RepositoryMemoryRetrievalLogTable)
          .values({
            id: crypto.randomUUID(),
            repository_id: full.repository.id,
            tool: "test",
            query: "futureMemory",
            returned_items: JSON.stringify([]),
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          .run()
      })

      const narrowed = yield* memory.indexLocalRepository({
        worktree: tmp.path,
        maxCommits: 1,
        cutoffTime: "2024-01-03T00:00:00Z",
        noGithub: true,
      })
      const status = yield* memory.status(narrowed.repository.identity)
      const staleMatches = yield* memory.searchCommitRows({
        repository_id: narrowed.repository.id,
        query: "futureMemory",
      })
      const keptMatches = yield* memory.searchCommitRows({
        repository_id: narrowed.repository.id,
        query: "middleMemory",
      })
      const summaries = Database.use((db) =>
        db
          .select()
          .from(RepositoryMemoryFileSummaryTable)
          .where(eq(RepositoryMemoryFileSummaryTable.repository_id, narrowed.repository.id))
          .all(),
      )
      const logs = Database.use((db) =>
        db
          .select()
          .from(RepositoryMemoryRetrievalLogTable)
          .where(eq(RepositoryMemoryRetrievalLogTable.repository_id, narrowed.repository.id))
          .all(),
      )

      expect(full.indexedCommits).toBe(3)
      expect(narrowed.indexedCommits).toBe(1)
      expect(status?.commits).toBe(1)
      expect(status?.file_activity).toBe(1)
      expect(status?.summaries).toBe(0)
      expect(staleMatches.some((match) => match.message === "add future memory")).toBe(false)
      expect(keptMatches[0].message).toBe("add middle memory")
      expect(JSON.parse(keptMatches[0].changed_files)).toEqual(["src/middle.ts"])
      expect(summaries).toHaveLength(0)
      expect(logs).toHaveLength(1)
    }),
  )

  it.live("treats base commit as an exclusive cutoff", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      yield* Effect.promise(() =>
        createCommit(
          tmp.path,
          "src/prior.ts",
          "export const priorMemory = true\n",
          "add prior memory",
          "2024-01-01T00:00:00Z",
        ),
      )
      yield* Effect.promise(() =>
        createCommit(
          tmp.path,
          "src/cutoff.ts",
          "export const cutoffMemory = true\n",
          "add cutoff memory",
          "2024-01-02T00:00:00Z",
        ),
      )
      const baseCommit = yield* Effect.promise(() =>
        $`git rev-parse HEAD`
          .cwd(tmp.path)
          .text()
          .then((hash) => hash.trim()),
      )
      yield* Effect.promise(() =>
        createCommit(
          tmp.path,
          "src/future.ts",
          "export const futureMemory = true\n",
          "add future memory",
          "2024-01-03T00:00:00Z",
        ),
      )

      const memory = yield* Memory.Service
      const result = yield* memory.indexLocalRepository({
        worktree: tmp.path,
        maxCommits: 10,
        baseCommit,
        noGithub: true,
      })
      const priorMatches = yield* memory.searchCommitRows({ repository_id: result.repository.id, query: "priorMemory" })
      const cutoffMatches = yield* memory.searchCommitRows({
        repository_id: result.repository.id,
        query: "cutoffMemory",
      })

      expect(result.indexedCommits).toBe(1)
      expect(priorMatches[0].message).toBe("add prior memory")
      expect(cutoffMatches.some((match) => match.message === "add cutoff memory")).toBe(false)
    }),
  )

  it.live("rejects ambiguous commit hash prefixes in one repository", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const repository = yield* memory.ensureRepository({ reference: "file:///tmp/opencode-memory-ambiguous-prefix" })
      yield* memory.upsertCommits(repository.id, [
        commitInput("abc111", "first ambiguous commit"),
        commitInput("abc222", "second ambiguous commit"),
      ])

      const result = yield* memory.getCommit({ repository_id: repository.id, hash: "abc" }).pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result))
        expect(Cause.squash(result.cause)).toMatchObject({ message: "Ambiguous commit hash prefix: abc" })
    }),
  )

  it.live("stores offline issue references unless GitHub enrichment is disabled", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      yield* Effect.promise(() =>
        createCommit(
          tmp.path,
          "src/linked.ts",
          "export const linkedIssue = true\n",
          "fix linked issue (#42)",
          "2024-01-01T00:00:00Z",
        ),
      )
      yield* Effect.promise(() => createMergeCommit(tmp.path))

      const memory = yield* Memory.Service
      const linked = yield* memory.indexLocalRepository({ worktree: tmp.path, maxCommits: 10 })
      const linkedIssues = Database.use((db) =>
        db
          .select({ issue_number: RepositoryMemoryCommitTable.issue_number })
          .from(RepositoryMemoryCommitTable)
          .where(eq(RepositoryMemoryCommitTable.repository_id, linked.repository.id))
          .all()
          .map((commit) => commit.issue_number)
          .filter((issue) => issue !== null)
          .toSorted(),
      )
      yield* memory.indexLocalRepository({ worktree: tmp.path, maxCommits: 10, noGithub: true })
      const disabledIssues = Database.use((db) =>
        db
          .select({ issue_number: RepositoryMemoryCommitTable.issue_number })
          .from(RepositoryMemoryCommitTable)
          .where(eq(RepositoryMemoryCommitTable.repository_id, linked.repository.id))
          .all()
          .map((commit) => commit.issue_number)
          .filter((issue) => issue !== null),
      )

      expect(linkedIssues).toEqual([42, 77])
      expect(disabledIssues).toEqual([])
    }),
  )
})

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

function commitInput(hash: string, message: string): Memory.CommitInput {
  return {
    hash,
    message,
    author_time: Date.now(),
    changed_files: ["src/ambiguous.ts"],
    diff: "diff --git a/src/ambiguous.ts b/src/ambiguous.ts\n",
    token_text: tokenText(message),
  }
}

async function createMergeCommit(dir: string) {
  await $`git checkout -b feature-linked-issue`.cwd(dir).quiet()
  await createCommit(dir, "src/merge-linked.ts", "export const mergeLinkedIssue = true\n", "add merge linked issue")
  await $`git checkout master`.cwd(dir).quiet()
  await $`git merge --no-ff feature-linked-issue -m ${"Merge pull request #77 from feature-linked-issue"}`
    .cwd(dir)
    .quiet()
}
