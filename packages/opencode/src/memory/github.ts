import { AppProcess } from "@opencode-ai/core/process"
import { Effect, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { MemoryIndex, type SourceItemInput } from "./repo"

const provider = "github"
const pageSize = 100

export interface IndexInput {
  readonly repo: string
  readonly since?: string
  readonly limit?: number
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
  const indexed = yield* Effect.all(
    comments.map((comment) => {
      const constraint = toConstraint(input.repo, comment)
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

export function toConstraint(repo: string, comment: ReviewComment): MemoryIndex.ConstraintInput | undefined {
  const text = constraintText(comment.body)
  if (!text || !comment.html_url) return

  const source = toSourceItem(repo, comment, text)
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
    if (pageComments.length < pageSize) return input.limit === undefined ? next : next.slice(0, input.limit)
    return yield* fetchPage(input, page + 1, next)
  })
}

function toSourceItem(repo: string, comment: ReviewComment, text: string): SourceItemInput {
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
    },
  }
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
