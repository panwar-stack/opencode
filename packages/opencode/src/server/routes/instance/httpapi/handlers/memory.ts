import { BackgroundJob } from "@/background/job"
import { Memory } from "@/memory/memory"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ApiNotFoundError, InvalidRequestError, notFound } from "../errors"
import type { CommitParams, CommitQuery, IndexPayload, SearchPayload, SummaryQuery } from "../groups/memory"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"

const historicalWarning = "This is historical memory. Verify against the current working tree before editing."

export const memoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const memory = yield* Memory.Service

    const index = Effect.fn("MemoryHttpApi.index")(function* (ctx: { payload: IndexPayload | undefined }) {
      const current = yield* memory.currentRepository(yield* routeDirectory())
      const job = yield* background.start({
        type: "memory.index",
        title: "Index repository memory",
        metadata: { repository: current.identity, worktree: current.worktree },
        run: memory
          .indexLocalRepository({
            worktree: current.worktree,
            maxCommits: ctx.payload?.max_commits,
            since: ctx.payload?.since,
            baseCommit: ctx.payload?.base_commit,
            cutoffTime: ctx.payload?.cutoff_time,
            branch: ctx.payload?.branch,
            noGithub: ctx.payload?.no_github,
            summaries: ctx.payload?.summaries,
          })
          .pipe(
            Effect.map((result) =>
              JSON.stringify({
                repository: result.repository.identity,
                indexed_commits: result.indexedCommits,
                skipped_commits: result.skippedCommits,
                file_activity: result.fileActivity,
                summaries: result.summaries,
              }),
            ),
          ),
      })
      return { job }
    })

    const status = Effect.fn("MemoryHttpApi.status")(function* () {
      const current = yield* memory.currentRepository(yield* routeDirectory())
      const indexed = yield* memory.status(current.identity)
      return {
        repository: current.identity,
        indexed: !!indexed,
        commits: indexed?.commits ?? 0,
        file_activity: indexed?.file_activity ?? 0,
        summaries: indexed?.summaries ?? 0,
      }
    })

    const searchCommit = Effect.fn("MemoryHttpApi.searchCommit")(function* (ctx: {
      payload: SearchPayload
    }) {
      const repository = yield* resolveRepository(memory, yield* routeDirectory())
      const commits = yield* memory.searchCommitRows({ repository_id: repository.id, query: ctx.payload.query, limit: ctx.payload.limit })
      const final_files = unique(commits.flatMap((commit) => parseJsonArray(commit.changed_files)))
      yield* memory.logRetrieval({
        repository_id: repository.id,
        tool: "memory_api_search_commit",
        query: ctx.payload.query,
        returned_items: commits.map((commit) => commit.hash),
        final_files,
      })
      return {
        repository: repository.identity,
        commits: commits.map((commit) => ({
          hash: commit.hash,
          message: commit.message,
          changed_files: parseJsonArray(commit.changed_files),
          score: commit.score,
          strength: commit.strength,
          ...(commit.issue_title ? { issue_title: commit.issue_title } : {}),
        })),
      }
    })

    const commit = Effect.fn("MemoryHttpApi.commit")(function* (ctx: { params: CommitParams; query: CommitQuery }) {
      const repository = yield* resolveRepository(memory, yield* routeDirectory())
      const row = yield* memory.getCommit({ repository_id: repository.id, hash: ctx.params.hash }).pipe(
        Effect.mapError(
          (error) =>
            new InvalidRequestError({
              message: error.message,
              kind: "Path",
              field: "hash",
            }),
        ),
      )
      if (!row) return yield* Effect.fail(notFound(`Commit memory not found: ${ctx.params.hash}`))
      const max = ctx.query.max_diff_bytes ?? 50_000
      const diff = row.diff.slice(0, max)
      yield* memory.logRetrieval({
        repository_id: repository.id,
        tool: "memory_api_commit",
        query: ctx.params.hash,
        returned_items: [row.hash],
        final_files: parseJsonArray(row.changed_files),
      })
      return {
        repository: repository.identity,
        hash: row.hash,
        message: row.message,
        changed_files: parseJsonArray(row.changed_files),
        diff,
        truncated: diff.length < row.diff.length,
        ...(row.issue_number ? { issue_number: row.issue_number } : {}),
        ...(row.issue_title ? { issue_title: row.issue_title } : {}),
        ...(row.issue_body ? { issue_body: row.issue_body } : {}),
        warning: historicalWarning,
      }
    })

    const searchSummary = Effect.fn("MemoryHttpApi.searchSummary")(function* (ctx: {
      payload: SearchPayload
    }) {
      const repository = yield* resolveRepository(memory, yield* routeDirectory())
      const summaries = yield* memory.searchSummaryRows({ repository_id: repository.id, query: ctx.payload.query, limit: ctx.payload.limit })
      yield* memory.logRetrieval({
        repository_id: repository.id,
        tool: "memory_api_search_summary",
        query: ctx.payload.query,
        returned_items: summaries.map((summary) => summary.path),
        final_files: summaries.map((summary) => summary.path),
      })
      return {
        repository: repository.identity,
        summaries: summaries.map((summary) => ({
          path: summary.path,
          summary: summary.summary,
          important_symbols: parseJsonArray(summary.important_symbols),
          source_hash: summary.source_hash,
          ...(summary.model_id ? { model_id: summary.model_id } : {}),
          score: summary.score,
          strength: summary.strength,
        })),
      }
    })

    const summary = Effect.fn("MemoryHttpApi.summary")(function* (ctx: { query: SummaryQuery }) {
      const current = yield* memory.currentRepository(yield* routeDirectory())
      const repository = yield* memory.getRepository(current.identity)
      if (!repository) return yield* Effect.fail(notFound(`No repository memory index found for ${current.identity}`))
      const row = yield* memory.getFileSummary({ repository_id: repository.id, path: ctx.query.path, worktree: current.worktree })
      if (!row) return yield* Effect.fail(notFound(`File summary not found: ${ctx.query.path}`))
      yield* memory.logRetrieval({
        repository_id: repository.id,
        tool: "memory_api_summary",
        query: ctx.query.path,
        returned_items: [row.path],
        final_files: [row.path],
      })
      return {
        repository: repository.identity,
        path: row.path,
        summary: row.summary,
        important_symbols: parseJsonArray(row.important_symbols),
        source_hash: row.source_hash,
        current_source_hash: row.current_source_hash,
        ...(row.model_id ? { model_id: row.model_id } : {}),
        time_generated: row.time_generated,
        stale: row.stale,
        missing: row.missing,
      }
    })

    const clear = Effect.fn("MemoryHttpApi.clear")(function* () {
      const current = yield* memory.currentRepository(yield* routeDirectory())
      return {
        repository: current.identity,
        cleared: yield* memory.clearRepository(current.identity),
      }
    })

    return handlers
      .handle("index", index)
      .handle("status", status)
      .handle("searchCommit", searchCommit)
      .handle("commit", commit)
      .handle("searchSummary", searchSummary)
      .handle("summary", summary)
      .handle("clear", clear)
  }),
)

function resolveRepository(memory: Memory.Interface, directory: string | undefined) {
  return Effect.gen(function* () {
    const current = yield* memory.currentRepository(directory)
    const repository = yield* memory.getRepository(current.identity)
    if (!repository) {
      return yield* Effect.fail(
        new ApiNotFoundError({ name: "NotFoundError", data: { message: `No repository memory index found for ${current.identity}` } }),
      )
    }
    return repository
  })
}

function routeDirectory() {
  return Effect.map(WorkspaceRouteContext, (ctx) => ctx.directory)
}

function parseJsonArray(input: string) {
  try {
    const parsed = JSON.parse(input) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === "string")
  } catch {
    return []
  }
}

function unique(input: readonly string[]) {
  return [...new Set(input)]
}
