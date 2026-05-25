import { $ } from "bun"
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { MemoryEval } from "@/memory/eval"
import { Memory } from "@/memory/memory"
import { RepositoryMemoryRetrievalLogTable } from "@/memory/memory.sql"
import { Database } from "@/storage/db"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Memory.defaultLayer))

describe("Memory eval", () => {
  it.live("evaluates cutoff-scoped localization and logs retrievals", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      yield* Effect.promise(() =>
        createCommit(tmp.path, "src/auth.ts", "export const loginRedirect = true\n", "fix login redirect", "2024-01-02T00:00:00Z"),
      )
      yield* Effect.promise(() =>
        createCommit(tmp.path, "src/future.ts", "export const futureLogin = true\n", "future login change", "2024-01-03T00:00:00Z"),
      )
      const issuesPath = path.join(tmp.path, "issues.json")
      yield* Effect.promise(() =>
        Bun.write(
          issuesPath,
          JSON.stringify([
            {
              id: "issue-login",
              query: "login redirect",
              cutoff_time: "2024-01-03T00:00:00Z",
              expected_files: ["src/auth.ts"],
            },
          ]),
        ),
      )

      const memory = yield* Memory.Service
      const result = yield* MemoryEval.run(memory, { issuesPath, worktree: tmp.path, maxCommits: 10, summaries: 0 })
      const logs = Database.use((db) =>
        db
          .select()
          .from(RepositoryMemoryRetrievalLogTable)
          .where(eq(RepositoryMemoryRetrievalLogTable.issue_identifier, "issue-login"))
          .all(),
      )

      expect(result.commit.hits_at_1).toBe(1)
      expect(result.combined.hits_at_1).toBe(1)
      expect(result.issues[0].combined_files).toContain("src/auth.ts")
      expect(result.issues[0].combined_files).not.toContain("src/future.ts")
      expect(logs.map((log) => log.tool).toSorted()).toEqual([
        "memory_eval_combined",
        "memory_eval_commit",
        "memory_eval_summary",
      ])
    }),
  )
})

async function createCommit(dir: string, file: string, content: string, message: string, date: string) {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
  await Bun.write(path.join(dir, file), content)
  await $`git add ${file}`.cwd(dir).quiet()
  const commit = Bun.spawn(["git", "commit", "--date", date, "-m", message], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdout: "ignore",
    stderr: "ignore",
  })
  if ((await commit.exited) !== 0) throw new Error("git commit failed")
}
