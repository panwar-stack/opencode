import { Effect, Schema } from "effect"
import type { Memory } from "./memory"

export const Issue = Schema.Struct({
  id: Schema.String,
  query: Schema.String,
  cutoff_commit: Schema.optional(Schema.String),
  cutoff_time: Schema.optional(Schema.String),
  expected_files: Schema.Array(Schema.String),
}).annotate({ identifier: "RepositoryMemoryEvalIssue" })

export type Issue = Schema.Schema.Type<typeof Issue>

export type Options = {
  readonly issuesPath: string
  readonly worktree?: string
  readonly maxCommits?: number
  readonly summaries?: number
  readonly searchLimit?: number
}

export type HitMetrics = {
  readonly hits_at_1: number
  readonly hits_at_3: number
  readonly hits_at_5: number
  readonly accuracy_at_1: number
  readonly accuracy_at_3: number
  readonly accuracy_at_5: number
}

export type IssueResult = {
  readonly id: string
  readonly query: string
  readonly expected_files: readonly string[]
  readonly commit_files: readonly string[]
  readonly summary_files: readonly string[]
  readonly combined_files: readonly string[]
  readonly commit_hits: readonly [boolean, boolean, boolean]
  readonly summary_hits: readonly [boolean, boolean, boolean]
  readonly combined_hits: readonly [boolean, boolean, boolean]
}

export type Result = {
  readonly total: number
  readonly issues: readonly IssueResult[]
  readonly commit: HitMetrics
  readonly summary: HitMetrics
  readonly combined: HitMetrics
}

const decodeIssues = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Issue)))

export const run = Effect.fn("MemoryEval.run")(function* (memory: Memory.Interface, options: Options) {
  const issues = yield* Effect.tryPromise({
    try: () => Bun.file(options.issuesPath).text(),
    catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
  }).pipe(
    Effect.flatMap((text) => decodeIssues(text)),
    Effect.mapError((error) => new Error(error instanceof Error ? error.message : String(error))),
  )

  const invalid = issues.find((issue) => !issue.cutoff_commit && !issue.cutoff_time)
  if (invalid) return yield* Effect.fail(new Error(`Issue ${invalid.id} must provide cutoff_commit or cutoff_time`))

  const results = yield* Effect.forEach(
    issues,
    (issue) => evaluateIssue(memory, issue, options),
    { concurrency: 1 },
  )

  return {
    total: results.length,
    issues: results,
    commit: metrics(results.map((result) => result.commit_hits)),
    summary: metrics(results.map((result) => result.summary_hits)),
    combined: metrics(results.map((result) => result.combined_hits)),
  } satisfies Result
})

export function format(result: Result) {
  return [
    `Issues evaluated: ${result.total}`,
    formatMetrics("Commit memory", result.commit, result.total),
    formatMetrics("Summary memory", result.summary, result.total),
    formatMetrics("Combined memory", result.combined, result.total),
    ...result.issues.flatMap((issue) => [
      `Issue ${issue.id}:`,
      `  Expected files: ${issue.expected_files.join(", ") || "none"}`,
      `  Commit files: ${issue.commit_files.join(", ") || "none"}`,
      `  Summary files: ${issue.summary_files.join(", ") || "none"}`,
      `  Combined files: ${issue.combined_files.join(", ") || "none"}`,
    ]),
  ]
}

const evaluateIssue = Effect.fn("MemoryEval.evaluateIssue")(function* (
  memory: Memory.Interface,
  issue: Issue,
  options: Options,
) {
  const indexed = yield* memory.indexLocalRepository({
    worktree: options.worktree,
    maxCommits: options.maxCommits,
    baseCommit: issue.cutoff_commit,
    cutoffTime: issue.cutoff_time,
    noGithub: true,
    summaries: options.summaries,
  })
  const searchLimit = options.searchLimit ?? 5
  const commits = yield* memory.searchCommitRows({ repository_id: indexed.repository.id, query: issue.query, limit: searchLimit })
  const summaries = yield* memory.searchSummaryRows({ repository_id: indexed.repository.id, query: issue.query, limit: searchLimit })
  const commit_files = unique(commits.flatMap((commit) => parseJsonArray(commit.changed_files)))
  const summary_files = unique(summaries.map((summary) => summary.path))
  const combined_files = unique([...commit_files, ...summary_files])

  yield* memory.logRetrieval({
    repository_id: indexed.repository.id,
    issue_identifier: issue.id,
    tool: "memory_eval_commit",
    query: issue.query,
    returned_items: commits.map((commit) => commit.hash),
    final_files: commit_files,
  })
  yield* memory.logRetrieval({
    repository_id: indexed.repository.id,
    issue_identifier: issue.id,
    tool: "memory_eval_summary",
    query: issue.query,
    returned_items: summary_files,
    final_files: summary_files,
  })
  yield* memory.logRetrieval({
    repository_id: indexed.repository.id,
    issue_identifier: issue.id,
    tool: "memory_eval_combined",
    query: issue.query,
    returned_items: combined_files,
    final_files: combined_files,
  })

  return {
    id: issue.id,
    query: issue.query,
    expected_files: issue.expected_files,
    commit_files,
    summary_files,
    combined_files,
    commit_hits: hits(commit_files, issue.expected_files),
    summary_hits: hits(summary_files, issue.expected_files),
    combined_hits: hits(combined_files, issue.expected_files),
  } satisfies IssueResult
})

function formatMetrics(label: string, metrics: HitMetrics, total: number) {
  return `${label}: accuracy@1=${formatAccuracy(metrics.hits_at_1, total)} accuracy@3=${formatAccuracy(metrics.hits_at_3, total)} accuracy@5=${formatAccuracy(metrics.hits_at_5, total)}`
}

function formatAccuracy(hits: number, total: number) {
  if (!total) return "0/0 (0.000)"
  return `${hits}/${total} ${(hits / total).toFixed(3)}`
}

function metrics(input: readonly (readonly [boolean, boolean, boolean])[]): HitMetrics {
  const hits_at_1 = input.filter((item) => item[0]).length
  const hits_at_3 = input.filter((item) => item[1]).length
  const hits_at_5 = input.filter((item) => item[2]).length
  const total = input.length
  return {
    hits_at_1,
    hits_at_3,
    hits_at_5,
    accuracy_at_1: total ? hits_at_1 / total : 0,
    accuracy_at_3: total ? hits_at_3 / total : 0,
    accuracy_at_5: total ? hits_at_5 / total : 0,
  }
}

function hits(files: readonly string[], expected: readonly string[]): readonly [boolean, boolean, boolean] {
  return [hasHit(files, expected, 1), hasHit(files, expected, 3), hasHit(files, expected, 5)]
}

function hasHit(files: readonly string[], expected: readonly string[], limit: number) {
  return files.slice(0, limit).some((file) => expected.includes(file))
}

function unique(input: readonly string[]) {
  return [...new Set(input)]
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

export * as MemoryEval from "./eval"
