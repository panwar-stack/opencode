import { AppProcess } from "@opencode-ai/core/process"
import { Effect, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { MemoryIndex, type SourceItemInput } from "./repo"

const provider = "github"
const pageSize = 100

export type IndexProgress =
  | {
      readonly type: "comments"
      readonly repo: string
      readonly page: number
      readonly fetched: number
      readonly total: number
      readonly limit?: number
    }
  | {
      readonly type: "pull_request"
      readonly repo: string
      readonly number: number
      readonly current: number
      readonly total: number
    }

export interface IndexInput {
  readonly repo: string
  readonly since?: string
  readonly limit?: number
  readonly throttle_ms?: number
  readonly onProgress?: (progress: IndexProgress) => void
  readonly include_authors?: readonly string[]
  readonly exclude_authors?: readonly string[]
  readonly max_age_days?: number
}

export interface IndexResult {
  readonly provider: typeof provider
  readonly repo: string
  readonly fetched: number
  readonly indexed: number
  readonly cursor?: string
}

export interface ReviewComment {
  readonly id: number
  readonly node_id?: string
  readonly body?: string
  readonly html_url?: string
  readonly pull_request_url?: string
  readonly path?: string
  readonly line?: number
  readonly original_line?: number
  readonly position?: number
  readonly original_position?: number
  readonly created_at?: string
  readonly updated_at?: string
  readonly in_reply_to_id?: number
  readonly pull_request_review_id?: number
  readonly author_association?: string
  readonly user?: {
    readonly login?: string
  }
}

interface PullRequest {
  readonly number?: number
  readonly title?: string
  readonly state?: string
  readonly merged?: boolean
  readonly closed_at?: string | null
  readonly merged_at?: string | null
  readonly base?: {
    readonly ref?: string
  }
  readonly head?: {
    readonly ref?: string
    readonly sha?: string
  }
}

interface PullRequestMetadata {
  readonly number: number
  readonly title: string
  readonly state: "open" | "closed"
  readonly merged: boolean
  readonly closed_at?: string
  readonly merged_at?: string
  readonly base_ref?: string
  readonly head_ref?: string
  readonly head_sha?: string
}

interface PullRequestCommit {
  readonly sha?: string
  readonly commit?: {
    readonly message?: string
    readonly author?: {
      readonly name?: string
      readonly date?: string
    }
  }
}

interface PullRequestCommitSummary {
  readonly sha: string
  readonly message: string
  readonly author?: string
  readonly authored_at?: string
}

interface PullRequestContext {
  readonly pr: PullRequestMetadata
  readonly commits?: PullRequestCommitSummary[]
}

export class GithubIndexError extends Schema.TaggedErrorClass<GithubIndexError>()("GithubMemoryIndexError", {
  message: Schema.String,
}) {}

export const index = Effect.fn("MemoryGithub.index")(function* (input: IndexInput) {
  const checkpoint = input.since
    ? undefined
    : yield* MemoryIndex.getSyncCheckpoint({ provider, repo: input.repo })
  const since = input.since ?? checkpoint?.cursor ?? undefined
  const comments = yield* fetchReviewComments({ ...input, since })
  return yield* indexComments({ ...input, since, comments })
})

export const indexComments = Effect.fn("MemoryGithub.indexComments")(function* (
  input: IndexInput & { readonly comments: readonly ReviewComment[] },
) {
  const comments = input.comments.filter(commentFilter(input))
  const pullRequests = yield* fetchPullRequests(input, comments)
  const indexed = yield* Effect.all(
    comments.map((comment) => {
      const number = prNumber(comment)
      const constraint = toConstraint(input.repo, comment, number === undefined ? undefined : pullRequests.get(number))
      if (!constraint) return Effect.succeed(undefined)
      return MemoryIndex.upsertConstraint(constraint).pipe(Effect.as(constraint))
    }),
    { concurrency: 1 },
  )

  const cursor = latestCursor(input.comments) ?? input.since
  yield* MemoryIndex.upsertSyncCheckpoint({
    provider,
    repo: input.repo,
    cursor,
    last_fetched_at: Date.now(),
    fetch_options: {
      limit: input.limit,
      since: input.since,
      include_authors: input.include_authors,
      exclude_authors: input.exclude_authors,
      max_age_days: input.max_age_days,
    },
  })

  return {
    provider,
    repo: input.repo,
    fetched: input.comments.length,
    indexed: indexed.filter(Boolean).length,
    cursor,
  } satisfies IndexResult
})

export function toConstraint(
  repo: string,
  comment: ReviewComment,
  pullRequest?: PullRequestContext,
): MemoryIndex.ConstraintInput | undefined {
  const text = constraintText(comment.body)
  if (!text || !comment.html_url) return

  const source = toSourceItem(repo, comment, text, pullRequest)
  return {
    provider,
    repo,
    title: titleFromText(text),
    text,
    confidence: confidence(comment),
    files: comment.path ? [comment.path] : [],
    directories: comment.path ? [directory(comment.path)] : [],
    citations: [{ label: citationLabel(source.pr_number), url: comment.html_url }],
    source_items: [source],
  }
}

export function parseReviewComments(text: string) {
  const parsed = JSON.parse(text) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isReviewComment)
}

function fetchReviewComments(input: IndexInput) {
  return fetchPage(input, 1, [])
}

function fetchPullRequests(input: IndexInput, comments: readonly ReviewComment[]) {
  return Effect.gen(function* () {
    const numbers = uniquePrNumbers(comments)
    const pullRequests = yield* Effect.all(
      numbers.map((number, index) =>
        Effect.gen(function* () {
          if (index > 0) yield* throttle(input)
          const metadata = yield* fetchPullRequest(input, number)
          yield* reportProgress(input, {
            type: "pull_request",
            repo: input.repo,
            number,
            current: index + 1,
            total: numbers.length,
          })
          return [number, metadata] as const
        }),
      ),
      { concurrency: 1 },
    )

    return new Map(
      pullRequests.filter((item): item is readonly [number, PullRequestContext] => item[1] !== undefined),
    )
  })
}

function fetchPullRequest(input: IndexInput, number: number) {
  return Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const result = yield* appProcess
      .run(ChildProcess.make("gh", ["api", `repos/${input.repo}/pulls/${number}`]), {
        maxOutputBytes: 1024 * 1024,
        maxErrorBytes: 64 * 1024,
      })
      .pipe(Effect.catch(() => Effect.succeed(undefined)))

    if (!result || result.exitCode !== 0) return undefined

    const pr = yield* Effect.try({
      try: () => parsePullRequest(result.stdout.toString("utf8")),
      catch: () => new GithubIndexError({ message: "Failed to parse GitHub pull request JSON" }),
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!pr) return undefined

    yield* throttle(input)
    const commits = yield* fetchPullRequestCommits(input.repo, number)
    return { pr, ...(commits && commits.length > 0 ? { commits } : {}) } satisfies PullRequestContext
  })
}

function fetchPullRequestCommits(repo: string, number: number) {
  return Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const result = yield* appProcess
      .run(ChildProcess.make("gh", ["api", `repos/${repo}/pulls/${number}/commits`, "--paginate"]), {
        maxOutputBytes: 5 * 1024 * 1024,
        maxErrorBytes: 64 * 1024,
      })
      .pipe(Effect.catch(() => Effect.succeed(undefined)))

    if (!result || result.exitCode !== 0) return undefined

    return yield* Effect.try({
      try: () => parsePullRequestCommits(result.stdout.toString("utf8")),
      catch: () => new GithubIndexError({ message: "Failed to parse GitHub pull request commits JSON" }),
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))
  })
}

function fetchPage(input: IndexInput, page: number, acc: readonly ReviewComment[]): Effect.Effect<ReviewComment[], GithubIndexError, AppProcess.Service> {
  if (input.limit !== undefined && acc.length >= input.limit) return Effect.succeed(acc.slice(0, input.limit))

  return Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const result = yield* appProcess
      .run(
        ChildProcess.make("gh", [
          "api",
          "-X",
          "GET",
          `repos/${input.repo}/pulls/comments`,
          "-f",
          "sort=updated",
          "-f",
          "direction=asc",
          "-f",
          `per_page=${pageSize}`,
          "-f",
          `page=${page}`,
          ...(input.since ? ["-f", `since=${input.since}`] : []),
        ]),
        { maxOutputBytes: 5 * 1024 * 1024, maxErrorBytes: 64 * 1024 },
      )
      .pipe(
        Effect.catch((error) =>
          Effect.fail(new GithubIndexError({ message: `Failed to run gh api: ${String(error)}` })),
        ),
      )

    if (result.exitCode !== 0) {
      return yield* new GithubIndexError({
        message: `Failed to fetch GitHub review comments for ${input.repo}: ${result.stderr.toString("utf8").trim()}`,
      })
    }

    const pageComments = yield* Effect.try({
      try: () => parseReviewComments(result.stdout.toString("utf8")),
      catch: () => new GithubIndexError({ message: "Failed to parse GitHub review comments JSON" }),
    })
    const next = [...acc, ...pageComments]
    yield* reportProgress(input, {
      type: "comments",
      repo: input.repo,
      page,
      fetched: pageComments.length,
      total: input.limit === undefined ? next.length : Math.min(next.length, input.limit),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    })
    if (pageComments.length < pageSize) return input.limit === undefined ? next : next.slice(0, input.limit)
    yield* throttle(input)
    return yield* fetchPage(input, page + 1, next)
  })
}

function reportProgress(input: IndexInput, progress: IndexProgress) {
  if (!input.onProgress) return Effect.void
  return Effect.sync(() => input.onProgress?.(progress))
}

function throttle(input: IndexInput) {
  if (!input.throttle_ms || input.throttle_ms <= 0) return Effect.void
  return Effect.sleep(`${input.throttle_ms} millis`)
}

function toSourceItem(
  repo: string,
  comment: ReviewComment,
  text: string,
  pullRequest: PullRequestContext | undefined,
): SourceItemInput {
  return {
    provider,
    repo,
    source_id: comment.node_id ?? String(comment.id),
    source_kind: comment.in_reply_to_id === undefined ? "review_comment" : "review_reply",
    pr_number: prNumber(comment),
    author: comment.user?.login,
    url: comment.html_url ?? "",
    path: comment.path,
    line: comment.line ?? comment.original_line,
    position: comment.position ?? comment.original_position,
    title: titleFromText(text),
    source_created_at: timestamp(comment.created_at),
    source_updated_at: timestamp(comment.updated_at),
    source_cursor: comment.updated_at,
    metadata: {
      author_association: comment.author_association,
      in_reply_to_id: comment.in_reply_to_id,
      pull_request_review_id: comment.pull_request_review_id,
      ...(pullRequest ?? {}),
    },
  }
}

function parsePullRequest(text: string): PullRequestMetadata | undefined {
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object") return undefined

  const item = parsed as PullRequest
  if (typeof item.number !== "number") return undefined
  if (typeof item.title !== "string") return undefined
  if (item.state !== "open" && item.state !== "closed") return undefined
  if (typeof item.merged !== "boolean") return undefined
  return {
    number: item.number,
    title: item.title,
    state: item.state,
    merged: item.merged,
    ...(typeof item.closed_at === "string" ? { closed_at: item.closed_at } : {}),
    ...(typeof item.merged_at === "string" ? { merged_at: item.merged_at } : {}),
    ...(typeof item.base?.ref === "string" ? { base_ref: item.base.ref } : {}),
    ...(typeof item.head?.ref === "string" ? { head_ref: item.head.ref } : {}),
    ...(typeof item.head?.sha === "string" ? { head_sha: item.head.sha } : {}),
  }
}

function parsePullRequestCommits(text: string) {
  const parsed = JSON.parse(text) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed
    .flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const commit = item as PullRequestCommit
      if (typeof commit.sha !== "string") return []
      if (typeof commit.commit?.message !== "string") return []
      return [
        {
          sha: commit.sha,
          message: commit.commit.message.split(/\r?\n/, 1)[0] ?? "",
          ...(typeof commit.commit.author?.name === "string" ? { author: commit.commit.author.name } : {}),
          ...(typeof commit.commit.author?.date === "string" ? { authored_at: commit.commit.author.date } : {}),
        } satisfies PullRequestCommitSummary,
      ]
    })
    .slice(0, 50)
}

function constraintText(input: string | undefined) {
  if (!input) return undefined
  const text = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(">"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  if (!text) return undefined
  if (text.length <= 500) return text
  return `${text.slice(0, 497)}...`
}

function confidence(comment: ReviewComment) {
  if (["OWNER", "MEMBER", "COLLABORATOR"].includes(comment.author_association ?? "")) return 0.75
  return 0.6
}

function commentFilter(input: IndexInput) {
  const includeAuthors = authorSet(input.include_authors)
  const excludeAuthors = authorSet(input.exclude_authors)
  const minUpdatedAt =
    input.max_age_days === undefined ? undefined : Date.now() - input.max_age_days * 24 * 60 * 60 * 1000

  return (comment: ReviewComment) => {
    const author = comment.user?.login?.toLowerCase()
    if (excludeAuthors.size > 0 && author && excludeAuthors.has(author)) return false
    if (includeAuthors.size > 0 && (!author || !includeAuthors.has(author))) return false
    if (minUpdatedAt === undefined) return true

    const updatedAt = timestamp(comment.updated_at ?? comment.created_at)
    return updatedAt !== undefined && updatedAt >= minUpdatedAt
  }
}

function authorSet(authors: readonly string[] | undefined) {
  return new Set(authors?.map((author) => author.trim().toLowerCase()).filter(Boolean) ?? [])
}

function uniquePrNumbers(comments: readonly ReviewComment[]) {
  return [...new Set(comments.map(prNumber).filter((item): item is number => item !== undefined))]
}

function latestCursor(comments: readonly ReviewComment[]) {
  return comments
    .map((comment) => comment.updated_at)
    .filter((item): item is string => item !== undefined)
    .sort()
    .at(-1)
}

function prNumber(comment: ReviewComment) {
  const match = (comment.pull_request_url ?? comment.html_url ?? "").match(/\/pulls?\/(\d+)(?:\D|$)/)
  if (!match) return undefined
  return Number(match[1])
}

function citationLabel(prNumber: number | undefined) {
  if (prNumber === undefined) return "GitHub review comment"
  return `PR #${prNumber} review comment`
}

function directory(file: string) {
  if (!file.includes("/")) return "."
  return file.split("/").slice(0, -1).join("/")
}

function titleFromText(text: string) {
  if (text.length <= 80) return text
  return `${text.slice(0, 77)}...`
}

function timestamp(input: string | undefined) {
  if (!input) return undefined
  const value = Date.parse(input)
  if (Number.isNaN(value)) return undefined
  return value
}

function isReviewComment(input: unknown): input is ReviewComment {
  if (!input || typeof input !== "object") return false
  const item = input as Record<string, unknown>
  return typeof item.id === "number"
}

export * as MemoryGithub from "./github"
