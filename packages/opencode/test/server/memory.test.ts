import { $ } from "bun"
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import * as Log from "@opencode-ai/core/util/log"
import { RepositoryMemoryRetrievalLogTable } from "@/memory/memory.sql"
import { Server } from "../../src/server/server"
import { Database } from "@/storage/db"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout, testEffectShared } from "../lib/effect"

void Log.init({ print: false })

const it = testEffectShared(Layer.empty)

type StatusResponse = {
  repository: string
  indexed: boolean
  commits: number
  file_activity: number
  summaries: number
}

type IndexResponse = {
  job: {
    id: string
    type: string
    status: string
    metadata?: Record<string, unknown>
  }
}

type CommitSearchResponse = {
  commits: readonly {
    hash: string
    changed_files: readonly string[]
  }[]
}

type CommitResponse = {
  hash: string
  changed_files: readonly string[]
  diff: string
  truncated: boolean
  warning: string
}

type SummarySearchResponse = {
  summaries: readonly unknown[]
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("memory HTTP API", () => {
  it.live("indexes in the background and serves repository memory retrieval endpoints", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      yield* Effect.promise(() =>
        createCommit(tmp.path, "src/auth.ts", "export const loginRedirect = 'redirect after login'\n", "fix login redirect"),
      )

      const started = yield* request(apiPath("/memory/index", tmp.path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ max_commits: 10, summaries: 0, no_github: true }),
      })
      expect(started.status).toBe(200)
      const job = yield* json<IndexResponse>(started)
      expect(job.job.type).toBe("memory.index")
      expect(job.job.metadata?.worktree).toBe(tmp.path)

      const status = yield* pollWithTimeout(
        Effect.gen(function* () {
          const response = yield* request(apiPath("/memory/status", tmp.path))
          expect(response.status).toBe(200)
          const body = yield* json<StatusResponse>(response)
          return body.commits === 1 ? body : undefined
        }),
        "memory index job did not finish",
        "10 seconds",
      )
      expect(status.indexed).toBe(true)
      expect(status.file_activity).toBe(1)

      const searched = yield* request(apiPath("/memory/search/commit", tmp.path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "login redirect", limit: 5 }),
      })
      expect(searched.status).toBe(200)
      const search = yield* json<CommitSearchResponse>(searched)
      expect(search.commits[0].changed_files).toEqual(["src/auth.ts"])

      const examined = yield* request(apiPath(`/memory/commit/${search.commits[0].hash.slice(0, 12)}?max_diff_bytes=10`, tmp.path))
      expect(examined.status).toBe(200)
      const commit = yield* json<CommitResponse>(examined)
      expect(commit.hash).toBe(search.commits[0].hash)
      expect(commit.changed_files).toEqual(["src/auth.ts"])
      expect(commit.truncated).toBe(true)
      expect(commit.warning).toContain("Verify against the current working tree")
      expect(commit.diff.length).toBeLessThanOrEqual(10)

      const summarySearch = yield* request(apiPath("/memory/search/summary", tmp.path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "login redirect", limit: 5 }),
      })
      expect(summarySearch.status).toBe(200)
      expect((yield* json<SummarySearchResponse>(summarySearch)).summaries).toEqual([])

      const logs = Database.use((db) => db.select().from(RepositoryMemoryRetrievalLogTable).all())
      expect(logs.map((log) => log.tool).filter((tool) => tool.startsWith("memory_api_")).toSorted()).toEqual([
        "memory_api_commit",
        "memory_api_search_commit",
        "memory_api_search_summary",
      ])

      const cleared = yield* request(apiPath("/memory", tmp.path), { method: "DELETE" })
      expect(cleared.status).toBe(200)
      const clearedStatus = yield* request(apiPath("/memory/status", tmp.path))
      expect((yield* json<StatusResponse>(clearedStatus)).indexed).toBe(false)
    }),
    20_000,
  )
})

function app() {
  return Server.Default().app
}

function request(input: string, init?: RequestInit) {
  return Effect.promise(() => Promise.resolve(app().request(input, init)))
}

function json<T>(response: Response) {
  return Effect.promise(() => response.json() as Promise<T>)
}

function apiPath(input: string, directory: string) {
  return `${input}${input.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`
}

async function createCommit(dir: string, file: string, content: string, message: string) {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
  await Bun.write(path.join(dir, file), content)
  await $`git add ${file}`.cwd(dir).quiet()
  await $`git commit -m ${message}`.cwd(dir).quiet()
}
