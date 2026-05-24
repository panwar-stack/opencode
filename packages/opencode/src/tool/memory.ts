import { Config } from "@/config/config"
import { ConfigMemory } from "@/config/memory"
import { Memory } from "@/memory/memory"
import { DEFAULT_LIMITS } from "@/memory/search"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/core/schema"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"

const DEFAULT_DIFF_BYTES = 20_000

const Repository = Schema.optional(Schema.String).annotate({
  description: "Repository to search, as a git URL, host/path reference, GitHub owner/repo shorthand, or omitted for the active repository",
})

export const SearchCommitParameters = Schema.Struct({
  queries: Schema.Array(Schema.String).annotate({
    description: "One or more natural-language, error-text, code-symbol, or file-path queries",
  }),
  limit: Schema.optional(PositiveInt).annotate({ description: "Maximum commits to return" }),
  repository: Repository,
})

export const ExamineCommitParameters = Schema.Struct({
  hash: Schema.String.annotate({ description: "Full commit hash or an unambiguous hash prefix" }),
  repository: Repository,
  max_diff_bytes: Schema.optional(NonNegativeInt).annotate({
    description: `Maximum historical diff bytes to return. Defaults to ${DEFAULT_DIFF_BYTES}.`,
  }),
})

export const SearchSummaryParameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Behavior, subsystem, error, function, or file-path query" }),
  limit: Schema.optional(PositiveInt).annotate({ description: "Maximum file summaries to return" }),
  repository: Repository,
})

export const ViewSummaryParameters = Schema.Struct({
  path: Schema.String.annotate({ description: "Repository-relative file path with a cached memory summary" }),
  repository: Repository,
})

export const MemorySearchCommitTool = Tool.define(
  "memory_search_commit",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const memory = yield* Memory.Service

    return {
      description:
        "SearchCommit. Search repository commit memory for past changes related to one or more natural-language or code queries.",
      parameters: SearchCommitParameters,
      execute: (params: Schema.Schema.Type<typeof SearchCommitParameters>, ctx) =>
        Effect.gen(function* () {
          const repository = yield* resolveRepository(memory, params.repository)
          yield* askMemory(ctx, "memory_search_commit", repository.identity, params.queries)
          const limit = params.limit ?? (yield* config.get()).memory?.search_commit_limit ?? DEFAULT_LIMITS.commits
          const rows = yield* Effect.forEach(
            params.queries.filter((query) => query.trim()),
            (query) => memory.searchCommitRows({ repository_id: repository.id, query, limit }),
          )
          const commits = dedupeRanked(rows.flat()).slice(0, limit)
          yield* logRetrieval(memory, ctx, repository.id, "memory_search_commit", params.queries, commits.map((commit) => commit.hash))
          return {
            title: commits.length ? `${commits.length} memory commit${commits.length === 1 ? "" : "s"}` : "No memory commits",
            metadata: { repository: repository.identity, count: commits.length },
            output: [
              `Repository memory commit search: ${repository.identity}`,
              weakWarning(commits),
              ...commits.map((commit, index) =>
                [
                  `${index + 1}. ${commit.hash} score=${formatScore(commit.score)} strong=${commit.strength === "strong"}`,
                  `Message: ${commit.message}`,
                  `Changed files: ${parseJsonArray(commit.changed_files).join(", ") || "none"}`,
                  commit.issue_title ? `Linked issue: ${commit.issue_number ? `#${commit.issue_number} ` : ""}${commit.issue_title}` : undefined,
                ]
                  .filter(Boolean)
                  .join("\n"),
              ),
              commits.length ? "Read current source before patching; these are historical localization hints." : "No matching commit memory found.",
            ]
              .filter(Boolean)
              .join("\n\n"),
          }
        }),
    }
  }),
)

export const MemoryExamineCommitTool = Tool.define(
  "memory_examine_commit",
  Effect.gen(function* () {
    const memory = yield* Memory.Service

    return {
      description: "ExamineCommit. Inspect a retrieved commit memory record.",
      parameters: ExamineCommitParameters,
      execute: (params: Schema.Schema.Type<typeof ExamineCommitParameters>, ctx) =>
        Effect.gen(function* () {
          const repository = yield* resolveRepository(memory, params.repository)
          yield* askMemory(ctx, "memory_examine_commit", repository.identity, [params.hash])
          const commit = yield* memory.getCommit({ repository_id: repository.id, hash: params.hash })
            .pipe(Effect.catch(Effect.die))
          if (!commit) return yield* Effect.die(new Error(`No repository memory commit found for hash: ${params.hash}`))
          yield* logRetrieval(memory, ctx, repository.id, "memory_examine_commit", [params.hash], [commit.hash])
          const max = params.max_diff_bytes ?? DEFAULT_DIFF_BYTES
          const diff = commit.diff.slice(0, max)
          const changed = parseJsonArray(commit.changed_files)
          return {
            title: commit.hash,
            metadata: { repository: repository.identity, hash: commit.hash, truncated: commit.diff.length > max },
            output: [
              `Repository memory commit: ${commit.hash}`,
              "Warning: this diff is historical. Old line numbers may not match current source; read current files before patching.",
              `Message: ${commit.message}`,
              `Changed files: ${changed.join(", ") || "none"}`,
              `Tests touched: ${changed.filter(isTestPath).join(", ") || "none"}`,
              commit.issue_title || commit.issue_body
                ? [`Linked issue: ${commit.issue_number ? `#${commit.issue_number}` : "unknown"}`, commit.issue_title, commit.issue_body]
                    .filter(Boolean)
                    .join("\n")
                : "Linked issue: none",
              `Historical diff${commit.diff.length > max ? ` (truncated to ${max} bytes from ${commit.diff.length})` : ""}:`,
              diff || "(empty diff)",
            ].join("\n\n"),
          }
        }),
    }
  }),
)

export const MemorySearchSummaryTool = Tool.define(
  "memory_search_summary",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const memory = yield* Memory.Service

    return {
      description: "SearchSummary. Search cached high-activity file summaries by behavior, subsystem, error, or function.",
      parameters: SearchSummaryParameters,
      execute: (params: Schema.Schema.Type<typeof SearchSummaryParameters>, ctx) =>
        Effect.gen(function* () {
          const repository = yield* resolveRepository(memory, params.repository)
          yield* askMemory(ctx, "memory_search_summary", repository.identity, [params.query])
          const limit = params.limit ?? (yield* config.get()).memory?.search_summary_limit ?? DEFAULT_LIMITS.summaries
          const summaries = yield* memory.searchSummaryRows({ repository_id: repository.id, query: params.query, limit })
          yield* logRetrieval(memory, ctx, repository.id, "memory_search_summary", [params.query], summaries.map((summary) => summary.path))
          return {
            title: summaries.length ? `${summaries.length} memory summar${summaries.length === 1 ? "y" : "ies"}` : "No memory summaries",
            metadata: { repository: repository.identity, count: summaries.length },
            output: [
              `Repository memory summary search: ${repository.identity}`,
              weakWarning(summaries),
              ...summaries.map((summary, index) =>
                [
                  `${index + 1}. ${summary.path} score=${formatScore(summary.score)} strong=${summary.strength === "strong"}`,
                  `Summary: ${summary.summary}`,
                  `Important symbols: ${parseJsonArray(summary.important_symbols).join(", ") || "none"}`,
                ].join("\n"),
              ),
              summaries.length ? "Use summaries as localization hints and verify against current source." : "No matching file summaries found.",
            ]
              .filter(Boolean)
              .join("\n\n"),
          }
        }),
    }
  }),
)

export const MemoryViewSummaryTool = Tool.define(
  "memory_view_summary",
  Effect.gen(function* () {
    const memory = yield* Memory.Service

    return {
      description: "ViewSummary. Show the cached repository-memory summary for a known file path.",
      parameters: ViewSummaryParameters,
      execute: (params: Schema.Schema.Type<typeof ViewSummaryParameters>, ctx) =>
        Effect.gen(function* () {
          const repository = yield* resolveRepository(memory, params.repository)
          yield* askMemory(ctx, "memory_view_summary", repository.identity, [params.path])
          const summary = yield* memory.getFileSummary({
            repository_id: repository.id,
            path: params.path,
            worktree: repository.worktree,
          })
          if (!summary) throw new Error(`No repository memory summary found for path: ${params.path}`)
          yield* logRetrieval(memory, ctx, repository.id, "memory_view_summary", [params.path], [summary.path])
          return {
            title: summary.path,
            metadata: { repository: repository.identity, path: summary.path, stale: summary.stale, missing: summary.missing },
            output: [
              `Repository memory summary: ${summary.path}`,
              `Status: ${summary.missing ? "missing current file" : summary.stale ? "stale" : "current"}`,
              `Source hash: ${summary.source_hash}`,
              summary.current_source_hash ? `Current source hash: ${summary.current_source_hash}` : undefined,
              `Generated: ${new Date(summary.time_generated).toISOString()}`,
              `Important symbols: ${parseJsonArray(summary.important_symbols).join(", ") || "none"}`,
              "Summary:",
              summary.summary,
            ]
              .filter(Boolean)
              .join("\n"),
          }
        }),
    }
  }),
)

export function toolsAvailable(config: Config.Info, memory: Memory.Interface, worktree?: string) {
  return Effect.gen(function* () {
    if (!ConfigMemory.enabled(config.memory)) return false
    const current = yield* memory.currentRepository(worktree).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!current) return false
    const status = yield* memory.status(current.identity)
    return status !== undefined && (status.commits > 0 || status.summaries > 0 || status.file_activity > 0)
  })
}

type RepositoryContext = {
  readonly id: string
  readonly identity: string
  readonly worktree?: string
}

function resolveRepository(memory: Memory.Interface, repository: string | undefined): Effect.Effect<RepositoryContext> {
  return Effect.gen(function* () {
    if (repository) {
      const identity = yield* memory.identity(repository)
      const stored = yield* memory.getRepository(identity.identity)
      if (!stored) throw new Error(`No repository memory index found for ${identity.identity}`)
      return { id: stored.id, identity: stored.identity }
    }

    const current = yield* memory.currentRepository()
    const stored = yield* memory.getRepository(current.identity)
    if (!stored) throw new Error(`No repository memory index found for active repository: ${current.identity}`)
    return { id: stored.id, identity: stored.identity, worktree: current.worktree }
  })
}

function askMemory(ctx: Tool.Context, permission: string, repository: string, patterns: readonly string[]) {
  return ctx.ask({
    permission,
    patterns: patterns.length ? patterns : [repository],
    always: [repository],
    metadata: { repository },
  })
}

function logRetrieval(
  memory: Memory.Interface,
  ctx: Tool.Context,
  repositoryID: string,
  tool: string,
  queries: readonly string[],
  returnedItems: readonly string[],
) {
  return memory.logRetrieval({
    repository_id: repositoryID,
    session_id: ctx.sessionID,
    issue_identifier: Memory.retrievalContext(ctx.sessionID)?.issueIdentifier,
    tool,
    query: queries.filter((query) => query.trim()).join("\n"),
    returned_items: returnedItems,
  })
}

function dedupeRanked<T extends { id: string; score: number }>(items: readonly T[]) {
  return [...items]
    .toSorted((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .filter((item, index, sorted) => sorted.findIndex((candidate) => candidate.id === item.id) === index)
}

function weakWarning(items: readonly { strength: "strong" | "weak" }[]) {
  if (!items.length || items.some((item) => item.strength === "strong")) return undefined
  return "Weak matches only; treat these as hypotheses and verify with current source before changing code."
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

function isTestPath(file: string) {
  return /(^|\/)(__tests__|test|tests)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
}

function formatScore(score: number) {
  return score.toFixed(2)
}
