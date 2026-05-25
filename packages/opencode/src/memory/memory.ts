import { and, asc, desc, eq, inArray, like, not, sql } from "drizzle-orm"
import { streamText, type ModelMessage } from "ai"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { Context, Effect, Layer } from "effect"
import * as Option from "effect/Option"
import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Database, type TxOrDb } from "@/storage/db"
import {
  RepositoryMemoryCommitTable,
  RepositoryMemoryFileActivityTable,
  RepositoryMemoryFileSummaryTable,
  RepositoryMemoryRepositoryTable,
  RepositoryMemoryRetrievalLogTable,
} from "./memory.sql"
import { DEFAULT_LIMITS, rankDocuments, tokenText, type RankedDocument } from "./search"
import { parseRepositoryReference, repositoryCacheIdentity, type Reference } from "@/util/repository"

const execFileAsync = promisify(execFile)

const DEFAULT_CORPUS_LIMITS = {
  commits: 7_000,
  summaries: 200,
} as const

const DEFAULT_INDEX_LIMITS = {
  maxCommits: 7_000,
  maxDiffBytes: 50_000,
  maxChangedFiles: 80,
  topCoChangedFiles: 20,
} as const

const SUMMARY_SYSTEM_PROMPT =
  "Summarize repository source files for retrieval. Return only JSON with keys summary and important_symbols."

export type RepositoryInput = {
  readonly reference: string | Reference
  readonly default_branch?: string
  readonly base_commit?: string
}

export type RepositoryIdentity = {
  readonly identity: string
  readonly provider?: string
  readonly owner?: string
  readonly name: string
}

export type CommitInput = {
  readonly hash: string
  readonly message: string
  readonly author_time: number
  readonly branch?: string
  readonly base_commit?: string
  readonly changed_files: readonly string[]
  readonly diff: string
  readonly issue_number?: number
  readonly issue_title?: string
  readonly issue_body?: string
  readonly token_text: string
}

export type FileActivityInput = {
  readonly path: string
  readonly edit_count: number
  readonly last_modified?: number
  readonly co_changed_files: readonly string[]
}

export type SummaryGeneratorInput = {
  readonly path: string
  readonly content: string
  readonly source_hash: string
  readonly edit_count: number
  readonly last_modified?: number | null
  readonly co_changed_files: readonly string[]
}

export type SummaryGeneratorResult = {
  readonly summary: string
  readonly important_symbols: readonly string[]
  readonly model_id?: string
}

export type SummaryGenerator = (input: SummaryGeneratorInput) => Effect.Effect<SummaryGeneratorResult, Error>

type SummarySource = {
  readonly content: string
  readonly source_hash: string
}

type SummarySourceReader = (file: string) => Effect.Effect<SummarySource, Error>

export type SummaryIndexResult = {
  readonly requested: number
  readonly generated: number
  readonly reused: number
  readonly failed: number
  readonly failures: readonly { readonly path: string; readonly message: string }[]
}

export type IndexProgress =
  | { readonly phase: "resolve" }
  | { readonly phase: "crawl"; readonly current?: number; readonly total?: number }
  | { readonly phase: "store"; readonly indexed: number; readonly skipped: number }
  | { readonly phase: "activity" }
  | { readonly phase: "summaries"; readonly current?: number; readonly total?: number }

export type FileSummarySearchResult = RankedDocument<typeof RepositoryMemoryFileSummaryTable.$inferSelect>

export type FileSummaryViewResult = typeof RepositoryMemoryFileSummaryTable.$inferSelect & {
  readonly stale: boolean
  readonly missing: boolean
  readonly current_source_hash?: string
}

export type IndexOptions = {
  readonly worktree?: string
  readonly maxCommits?: number
  readonly since?: string
  readonly baseCommit?: string
  readonly cutoffTime?: string
  readonly branch?: string
  readonly noGithub?: boolean
  readonly maxFiles?: number
  readonly summaries?: number
  readonly summaryGenerator?: SummaryGenerator
  readonly onProgress?: (progress: IndexProgress) => Effect.Effect<void>
}

export type IndexResult = {
  readonly repository: typeof RepositoryMemoryRepositoryTable.$inferSelect
  readonly worktree: string
  readonly indexedCommits: number
  readonly skippedCommits: number
  readonly fileActivity: number
  readonly summaries: SummaryIndexResult
}

export type StatusResult = {
  readonly repository: typeof RepositoryMemoryRepositoryTable.$inferSelect
  readonly commits: number
  readonly file_activity: number
  readonly summaries: number
}

export type CommitSearchResult = RankedDocument<typeof RepositoryMemoryCommitTable.$inferSelect>

export type RetrievalLogInput = {
  readonly repository_id: string
  readonly session_id?: string
  readonly issue_identifier?: string
  readonly tool: string
  readonly query: string
  readonly returned_items: readonly string[]
  readonly selected_items?: readonly string[]
  readonly final_files?: readonly string[]
  readonly outcome?: string
}

export type RetrievalContext = {
  readonly issueIdentifier?: string
}

export interface Interface {
  readonly tables: {
    readonly repository: typeof RepositoryMemoryRepositoryTable
    readonly commit: typeof RepositoryMemoryCommitTable
    readonly fileActivity: typeof RepositoryMemoryFileActivityTable
    readonly fileSummary: typeof RepositoryMemoryFileSummaryTable
    readonly retrievalLog: typeof RepositoryMemoryRetrievalLogTable
  }
  readonly identity: (reference: string | Reference) => Effect.Effect<RepositoryIdentity>
  readonly getRepository: (
    identity: string,
  ) => Effect.Effect<typeof RepositoryMemoryRepositoryTable.$inferSelect | undefined>
  readonly ensureRepository: (
    input: RepositoryInput,
  ) => Effect.Effect<typeof RepositoryMemoryRepositoryTable.$inferSelect>
  readonly currentRepository: (worktree?: string) => Effect.Effect<RepositoryIdentity & { readonly worktree: string }>
  readonly indexLocalRepository: (input?: IndexOptions) => Effect.Effect<IndexResult>
  readonly upsertCommits: (repository_id: string, commits: readonly CommitInput[]) => Effect.Effect<number>
  readonly upsertFileActivity: (repository_id: string, files: readonly FileActivityInput[]) => Effect.Effect<number>
  readonly status: (identity: string) => Effect.Effect<StatusResult | undefined>
  readonly clearRepository: (identity: string) => Effect.Effect<boolean>
  readonly getCommit: (input: {
    repository_id: string
    hash: string
  }) => Effect.Effect<typeof RepositoryMemoryCommitTable.$inferSelect | undefined, Error>
  readonly searchCommitRows: (input: {
    repository_id: string
    query: string
    limit?: number
  }) => Effect.Effect<CommitSearchResult[]>
  readonly searchCommits: (input: {
    repository_id: string
    query: string
    limit?: number
  }) => Effect.Effect<ReturnType<typeof rankDocuments>>
  readonly searchSummaries: (input: {
    repository_id: string
    query: string
    limit?: number
  }) => Effect.Effect<ReturnType<typeof rankDocuments>>
  readonly searchSummaryRows: (input: {
    repository_id: string
    query: string
    limit?: number
  }) => Effect.Effect<FileSummarySearchResult[]>
  readonly getFileSummary: (input: {
    repository_id: string
    path: string
    worktree?: string
  }) => Effect.Effect<FileSummaryViewResult | undefined>
  readonly logRetrieval: (input: RetrievalLogInput) => Effect.Effect<void>
  readonly generateFileSummaries: (input: {
    readonly repository_id: string
    readonly worktree: string
    readonly limit?: number
    readonly generator?: SummaryGenerator
    readonly source?: SummarySourceReader
    readonly onProgress?: IndexOptions["onProgress"]
  }) => Effect.Effect<SummaryIndexResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

const retrievalContexts = new Map<string, RetrievalContext>()

export function setRetrievalContext(input: { readonly sessionID: string; readonly context: RetrievalContext }) {
  retrievalContexts.set(input.sessionID, input.context)
}

export function clearRetrievalContext(sessionID: string) {
  retrievalContexts.delete(sessionID)
}

export function retrievalContext(sessionID: string) {
  return retrievalContexts.get(sessionID)
}

export function identity(reference: string | Reference): RepositoryIdentity {
  const parsed = typeof reference === "string" ? parseRepositoryReference(reference) : reference
  if (!parsed)
    throw new Error("Repository must be a git URL, host/path reference, GitHub owner/repo shorthand, or file URL")
  return {
    identity: repositoryCacheIdentity(parsed),
    provider: parsed.host === "github.com" ? "github" : parsed.host === "file" ? "file" : parsed.host,
    owner: parsed.owner,
    name: parsed.repo,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = <T>(fn: (d: TxOrDb) => T) => Effect.sync(() => Database.use(fn))

    const getRepository = Effect.fn("Memory.getRepository")(function* (repositoryIdentity: string) {
      return yield* db((d) =>
        d
          .select()
          .from(RepositoryMemoryRepositoryTable)
          .where(eq(RepositoryMemoryRepositoryTable.identity, repositoryIdentity))
          .get(),
      )
    })

    const ensureRepository = Effect.fn("Memory.ensureRepository")(function* (input: RepositoryInput) {
      const normalized = identity(input.reference)
      const now = Date.now()
      yield* db((d) =>
        d
          .insert(RepositoryMemoryRepositoryTable)
          .values({
            id: crypto.randomUUID(),
            identity: normalized.identity,
            provider: normalized.provider,
            owner: normalized.owner,
            name: normalized.name,
            default_branch: input.default_branch,
            base_commit: input.base_commit,
            time_created: now,
            time_updated: now,
          })
          .onConflictDoUpdate({
            target: RepositoryMemoryRepositoryTable.identity,
            set: {
              provider: normalized.provider,
              owner: normalized.owner,
              name: normalized.name,
              default_branch: input.default_branch,
              base_commit: input.base_commit,
              time_updated: now,
            },
          })
          .run(),
      )
      return yield* getRepository(normalized.identity).pipe(
        Effect.flatMap((row) => (row ? Effect.succeed(row) : Effect.die(new Error("repository memory upsert failed")))),
      )
    })

    const upsertCommits = Effect.fn("Memory.upsertCommits")(function* (
      repository_id: string,
      commits: readonly CommitInput[],
    ) {
      if (!commits.length) return 0
      const now = Date.now()
      yield* db((d) =>
        d
          .delete(RepositoryMemoryCommitTable)
          .where(
            and(
              eq(RepositoryMemoryCommitTable.repository_id, repository_id),
              inArray(
                RepositoryMemoryCommitTable.hash,
                commits.map((commit) => commit.hash),
              ),
            ),
          )
          .run(),
      )
      yield* db((d) =>
        d
          .insert(RepositoryMemoryCommitTable)
          .values(
            commits.map((commit) => ({
              id: crypto.randomUUID(),
              repository_id,
              hash: commit.hash,
              message: commit.message,
              author_time: commit.author_time,
              branch: commit.branch,
              base_commit: commit.base_commit,
              changed_files: JSON.stringify(commit.changed_files),
              diff: commit.diff,
              issue_number: commit.issue_number,
              issue_title: commit.issue_title,
              issue_body: commit.issue_body,
              token_text: commit.token_text,
              time_created: now,
              time_updated: now,
            })),
          )
          .run(),
      )
      return commits.length
    })

    const upsertFileActivity = Effect.fn("Memory.upsertFileActivity")(function* (
      repository_id: string,
      files: readonly FileActivityInput[],
    ) {
      const now = Date.now()
      yield* db((d) =>
        d
          .delete(RepositoryMemoryFileActivityTable)
          .where(eq(RepositoryMemoryFileActivityTable.repository_id, repository_id))
          .run(),
      )
      if (!files.length) return 0
      yield* db((d) =>
        d
          .insert(RepositoryMemoryFileActivityTable)
          .values(
            files.map((file) => ({
              id: crypto.randomUUID(),
              repository_id,
              path: file.path,
              edit_count: file.edit_count,
              last_modified: file.last_modified,
              co_changed_files: JSON.stringify(file.co_changed_files),
              time_created: now,
              time_updated: now,
            })),
          )
          .run(),
      )
      return files.length
    })

    const pruneFileSummaries = Effect.fn("Memory.pruneFileSummaries")(function* (
      repository_id: string,
      paths: readonly string[],
    ) {
      yield* db((d) =>
        d
          .delete(RepositoryMemoryFileSummaryTable)
          .where(
            paths.length
              ? and(
                  eq(RepositoryMemoryFileSummaryTable.repository_id, repository_id),
                  not(inArray(RepositoryMemoryFileSummaryTable.path, [...paths])),
                )
              : eq(RepositoryMemoryFileSummaryTable.repository_id, repository_id),
          )
          .run(),
      )
    })

    const currentRepository = Effect.fn("Memory.currentRepository")(function* (worktree = process.cwd()) {
      const root = yield* git(worktree, ["rev-parse", "--show-toplevel"])
      const remote = yield* optionalGit(root, ["remote", "get-url", "origin"])
      return { ...identity(remote.trim() || pathToFileURL(root).href), worktree: root }
    })

    const indexLocalRepository = Effect.fn("Memory.indexLocalRepository")(function* (input: IndexOptions = {}) {
      if (input.onProgress) yield* input.onProgress({ phase: "resolve" })
      const current = yield* currentRepository(input.worktree)
      const branch = input.branch ?? (yield* git(current.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]))
      const repository = yield* ensureRepository({
        reference: current.provider === "file" ? pathToFileURL(current.worktree).href : current.identity,
        default_branch: branch.trim() === "HEAD" ? undefined : branch.trim(),
        base_commit: input.baseCommit,
      })
      const commits = yield* crawlCommits(current.worktree, {
        maxCommits: input.maxCommits ?? DEFAULT_INDEX_LIMITS.maxCommits,
        since: input.since,
        baseCommit: input.baseCommit,
        cutoffTime: input.cutoffTime,
        branch: branch.trim(),
        noGithub: input.noGithub,
        maxFiles: input.maxFiles ?? DEFAULT_INDEX_LIMITS.maxChangedFiles,
        onProgress: input.onProgress,
      })
      if (input.onProgress)
        yield* input.onProgress({ phase: "store", indexed: commits.indexed.length, skipped: commits.skipped })
      yield* db((d) =>
        d.delete(RepositoryMemoryCommitTable).where(eq(RepositoryMemoryCommitTable.repository_id, repository.id)).run(),
      )
      yield* upsertCommits(repository.id, commits.indexed)
      if (input.onProgress) yield* input.onProgress({ phase: "activity" })
      const activity = fileActivity(commits.indexed)
      yield* upsertFileActivity(repository.id, activity)
      const summaryLimit = input.summaries ?? DEFAULT_CORPUS_LIMITS.summaries
      const summaries =
        summaryLimit <= 0
          ? yield* pruneFileSummaries(repository.id, []).pipe(
              Effect.map(() => ({ requested: 0, generated: 0, reused: 0, failed: 0, failures: [] })),
            )
          : yield* generateFileSummaries({
              repository_id: repository.id,
              worktree: current.worktree,
              limit: summaryLimit,
              generator: input.summaryGenerator,
              source: summarySourceFromCommits(current.worktree, commits.indexed),
              onProgress: input.onProgress,
            })
      return {
        repository,
        worktree: current.worktree,
        indexedCommits: commits.indexed.length,
        skippedCommits: commits.skipped,
        fileActivity: activity.length,
        summaries,
      }
    })

    const status = Effect.fn("Memory.status")(function* (repositoryIdentity: string) {
      const repository = yield* getRepository(repositoryIdentity)
      if (!repository) return undefined
      const counts = yield* db((d) => ({
        commits:
          d
            .select({ count: sql<number>`count(*)` })
            .from(RepositoryMemoryCommitTable)
            .where(eq(RepositoryMemoryCommitTable.repository_id, repository.id))
            .get()?.count ?? 0,
        file_activity:
          d
            .select({ count: sql<number>`count(*)` })
            .from(RepositoryMemoryFileActivityTable)
            .where(eq(RepositoryMemoryFileActivityTable.repository_id, repository.id))
            .get()?.count ?? 0,
        summaries:
          d
            .select({ count: sql<number>`count(*)` })
            .from(RepositoryMemoryFileSummaryTable)
            .where(eq(RepositoryMemoryFileSummaryTable.repository_id, repository.id))
            .get()?.count ?? 0,
      }))
      return { repository, ...counts }
    })

    const clearRepository = Effect.fn("Memory.clearRepository")(function* (repositoryIdentity: string) {
      const repository = yield* getRepository(repositoryIdentity)
      if (!repository) return false
      yield* db((d) =>
        d.delete(RepositoryMemoryRepositoryTable).where(eq(RepositoryMemoryRepositoryTable.id, repository.id)).run(),
      )
      return true
    })

    const getCommit = Effect.fn("Memory.getCommit")(function* (input: { repository_id: string; hash: string }) {
      const matches = yield* db((d) =>
        d
          .select()
          .from(RepositoryMemoryCommitTable)
          .where(
            and(
              eq(RepositoryMemoryCommitTable.repository_id, input.repository_id),
              like(RepositoryMemoryCommitTable.hash, `${input.hash}%`),
            ),
          )
          .orderBy(desc(RepositoryMemoryCommitTable.author_time))
          .limit(2)
          .all(),
      )
      if (matches.length > 1) return yield* Effect.fail(new Error(`Ambiguous commit hash prefix: ${input.hash}`))
      return matches[0]
    })

    const searchCommits = Effect.fn("Memory.searchCommits")(function* (input: {
      repository_id: string
      query: string
      limit?: number
    }) {
      return rankDocuments(
        input.query,
        yield* db((d) =>
          d
            .select({ id: RepositoryMemoryCommitTable.id, token_text: RepositoryMemoryCommitTable.token_text })
            .from(RepositoryMemoryCommitTable)
            .where(eq(RepositoryMemoryCommitTable.repository_id, input.repository_id))
            .orderBy(desc(RepositoryMemoryCommitTable.author_time))
            .limit(DEFAULT_CORPUS_LIMITS.commits)
            .all(),
        ),
        input.limit ?? DEFAULT_LIMITS.commits,
      )
    })

    const searchCommitRows = Effect.fn("Memory.searchCommitRows")(function* (input: {
      repository_id: string
      query: string
      limit?: number
    }) {
      const ranked = yield* searchCommits(input)
      if (!ranked.length) return []
      const rows = yield* db((d) =>
        d
          .select()
          .from(RepositoryMemoryCommitTable)
          .where(
            inArray(
              RepositoryMemoryCommitTable.id,
              ranked.map((item) => item.id),
            ),
          )
          .all(),
      )
      return ranked
        .map((item) => {
          const row = rows.find((candidate) => candidate.id === item.id)
          if (!row) return undefined
          return { ...row, ...item } satisfies CommitSearchResult
        })
        .filter((item): item is CommitSearchResult => item !== undefined)
    })

    const searchSummaries = Effect.fn("Memory.searchSummaries")(function* (input: {
      repository_id: string
      query: string
      limit?: number
    }) {
      return rankDocuments(
        input.query,
        yield* db((d) =>
          d
            .select({
              id: RepositoryMemoryFileSummaryTable.id,
              token_text: RepositoryMemoryFileSummaryTable.token_text,
            })
            .from(RepositoryMemoryFileSummaryTable)
            .where(eq(RepositoryMemoryFileSummaryTable.repository_id, input.repository_id))
            .orderBy(desc(RepositoryMemoryFileSummaryTable.time_generated))
            .limit(DEFAULT_CORPUS_LIMITS.summaries)
            .all(),
        ),
        input.limit ?? DEFAULT_LIMITS.summaries,
      )
    })

    const searchSummaryRows = Effect.fn("Memory.searchSummaryRows")(function* (input: {
      repository_id: string
      query: string
      limit?: number
    }) {
      const ranked = yield* searchSummaries(input)
      if (!ranked.length) return []
      const rows = yield* db((d) =>
        d
          .select()
          .from(RepositoryMemoryFileSummaryTable)
          .where(
            inArray(
              RepositoryMemoryFileSummaryTable.id,
              ranked.map((item) => item.id),
            ),
          )
          .all(),
      )
      return ranked
        .map((item) => {
          const row = rows.find((candidate) => candidate.id === item.id)
          if (!row) return undefined
          return { ...row, ...item } satisfies FileSummarySearchResult
        })
        .filter((item): item is FileSummarySearchResult => item !== undefined)
    })

    const getFileSummary = Effect.fn("Memory.getFileSummary")(function* (input: {
      repository_id: string
      path: string
      worktree?: string
    }) {
      const row = yield* db((d) =>
        d
          .select()
          .from(RepositoryMemoryFileSummaryTable)
          .where(
            and(
              eq(RepositoryMemoryFileSummaryTable.repository_id, input.repository_id),
              eq(RepositoryMemoryFileSummaryTable.path, input.path),
            ),
          )
          .get(),
      )
      if (!row) return undefined
      if (!input.worktree) return { ...row, stale: false, missing: false }
      const source = yield* readSummarySource(input.worktree, input.path).pipe(
        Effect.match({
          onFailure: () => undefined,
          onSuccess: (result) => result,
        }),
      )
      if (!source) return { ...row, stale: true, missing: true }
      return {
        ...row,
        stale: row.source_hash !== source.source_hash,
        missing: false,
        current_source_hash: source.source_hash,
      }
    })

    const logRetrieval = Effect.fn("Memory.logRetrieval")(function* (input: RetrievalLogInput) {
      const now = Date.now()
      yield* db((d) =>
        d
          .insert(RepositoryMemoryRetrievalLogTable)
          .values({
            id: crypto.randomUUID(),
            repository_id: input.repository_id,
            session_id: input.session_id,
            issue_identifier: input.issue_identifier,
            tool: input.tool,
            query: input.query,
            returned_items: JSON.stringify(input.returned_items),
            selected_items: input.selected_items ? JSON.stringify(input.selected_items) : undefined,
            final_files: input.final_files ? JSON.stringify(input.final_files) : undefined,
            outcome: input.outcome,
            time_created: now,
            time_updated: now,
          })
          .run(),
      )
    })

    const generateFileSummaries = Effect.fn("Memory.generateFileSummaries")(function* (input: {
      readonly repository_id: string
      readonly worktree: string
      readonly limit?: number
      readonly generator?: SummaryGenerator
      readonly source?: SummarySourceReader
      readonly onProgress?: IndexOptions["onProgress"]
    }) {
      const limit = input.limit ?? DEFAULT_CORPUS_LIMITS.summaries
      if (limit <= 0) {
        yield* pruneFileSummaries(input.repository_id, [])
        return { requested: 0, generated: 0, reused: 0, failed: 0, failures: [] }
      }
      const files = yield* db((d) =>
        d
          .select()
          .from(RepositoryMemoryFileActivityTable)
          .where(eq(RepositoryMemoryFileActivityTable.repository_id, input.repository_id))
          .orderBy(
            desc(RepositoryMemoryFileActivityTable.edit_count),
            desc(RepositoryMemoryFileActivityTable.last_modified),
            asc(RepositoryMemoryFileActivityTable.path),
          )
          .limit(limit)
          .all(),
      )
      yield* pruneFileSummaries(
        input.repository_id,
        files.map((file) => file.path),
      )
      if (input.onProgress) yield* input.onProgress({ phase: "summaries", current: 0, total: files.length })
      const generator = input.generator ?? (yield* defaultSummaryGenerator())
      let completed = 0
      const results = yield* Effect.forEach(
        files,
        (file) =>
          Effect.gen(function* () {
            const result = yield* summarizeFile(
              input.repository_id,
              input.source ?? worktreeSummarySource(input.worktree),
              file,
              generator,
            )
            completed++
            if (input.onProgress)
              yield* input.onProgress({ phase: "summaries", current: completed, total: files.length })
            return result
          }),
        { concurrency: 2 },
      )
      return {
        requested: files.length,
        generated: results.filter((result) => result.type === "generated").length,
        reused: results.filter((result) => result.type === "reused").length,
        failed: results.filter((result) => result.type === "failed").length,
        failures: results.flatMap((result) =>
          result.type === "failed" ? [{ path: result.path, message: result.message }] : [],
        ),
      }
    })

    const summarizeFile = Effect.fn("Memory.summarizeFile")(function* (
      repository_id: string,
      sourceReader: SummarySourceReader,
      file: typeof RepositoryMemoryFileActivityTable.$inferSelect,
      generator: SummaryGenerator,
    ) {
      const source = yield* sourceReader(file.path).pipe(
        Effect.match({
          onFailure: (error) => ({ type: "failed" as const, path: file.path, message: error.message }),
          onSuccess: (result) => ({ type: "source" as const, ...result }),
        }),
      )
      if (source.type === "failed") {
        yield* db((d) =>
          d
            .delete(RepositoryMemoryFileSummaryTable)
            .where(
              and(
                eq(RepositoryMemoryFileSummaryTable.repository_id, repository_id),
                eq(RepositoryMemoryFileSummaryTable.path, file.path),
              ),
            )
            .run(),
        )
        return source
      }
      const existing = yield* db((d) =>
        d
          .select()
          .from(RepositoryMemoryFileSummaryTable)
          .where(
            and(
              eq(RepositoryMemoryFileSummaryTable.repository_id, repository_id),
              eq(RepositoryMemoryFileSummaryTable.path, file.path),
            ),
          )
          .get(),
      )
      if (existing?.source_hash === source.source_hash) {
        yield* db((d) =>
          d
            .update(RepositoryMemoryFileSummaryTable)
            .set({ time_generated: Date.now(), time_updated: Date.now() })
            .where(
              and(
                eq(RepositoryMemoryFileSummaryTable.repository_id, repository_id),
                eq(RepositoryMemoryFileSummaryTable.path, file.path),
              ),
            )
            .run(),
        )
        return { type: "reused" as const, path: file.path }
      }
      const generated = yield* generator({
        path: file.path,
        content: source.content,
        source_hash: source.source_hash,
        edit_count: file.edit_count,
        last_modified: file.last_modified,
        co_changed_files: parseJsonArray(file.co_changed_files),
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ type: "failed" as const, path: file.path, message: error.message }),
          onSuccess: (result) => ({ type: "summary" as const, ...result }),
        }),
      )
      if (generated.type === "failed") {
        yield* db((d) =>
          d
            .delete(RepositoryMemoryFileSummaryTable)
            .where(
              and(
                eq(RepositoryMemoryFileSummaryTable.repository_id, repository_id),
                eq(RepositoryMemoryFileSummaryTable.path, file.path),
              ),
            )
            .run(),
        )
        return generated
      }
      const now = Date.now()
      yield* db((d) =>
        d
          .delete(RepositoryMemoryFileSummaryTable)
          .where(
            and(
              eq(RepositoryMemoryFileSummaryTable.repository_id, repository_id),
              eq(RepositoryMemoryFileSummaryTable.path, file.path),
            ),
          )
          .run(),
      )
      yield* db((d) =>
        d
          .insert(RepositoryMemoryFileSummaryTable)
          .values({
            id: crypto.randomUUID(),
            repository_id,
            path: file.path,
            source_hash: source.source_hash,
            summary: generated.summary,
            important_symbols: JSON.stringify(generated.important_symbols),
            token_text: tokenText([file.path, generated.summary, generated.important_symbols.join(" ")].join("\n")),
            model_id: generated.model_id,
            time_generated: now,
            time_created: now,
            time_updated: now,
          })
          .run(),
      )
      return { type: "generated" as const, path: file.path }
    })

    return {
      tables: {
        repository: RepositoryMemoryRepositoryTable,
        commit: RepositoryMemoryCommitTable,
        fileActivity: RepositoryMemoryFileActivityTable,
        fileSummary: RepositoryMemoryFileSummaryTable,
        retrievalLog: RepositoryMemoryRetrievalLogTable,
      },
      identity: (reference) => Effect.sync(() => identity(reference)),
      getRepository,
      ensureRepository,
      currentRepository,
      indexLocalRepository,
      upsertCommits,
      upsertFileActivity,
      status,
      clearRepository,
      getCommit,
      searchCommitRows,
      searchCommits,
      searchSummaries,
      searchSummaryRows,
      getFileSummary,
      logRetrieval,
      generateFileSummaries,
    }
  }),
)

export const defaultLayer = layer

function git(cwd: string, args: readonly string[]) {
  return Effect.promise(() =>
    execFileAsync("git", [...args], { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 100 }),
  ).pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.catch(Effect.die),
  )
}

function optionalGit(cwd: string, args: readonly string[]) {
  return Effect.promise(() =>
    execFileAsync("git", [...args], { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 100 })
      .then((result) => result.stdout.trim())
      .catch(() => ""),
  )
}

const crawlCommits = Effect.fn("Memory.crawlCommits")(function* (
  worktree: string,
  options: Required<Pick<IndexOptions, "maxCommits" | "branch" | "maxFiles">> &
    Pick<IndexOptions, "since" | "baseCommit" | "cutoffTime" | "noGithub" | "onProgress">,
) {
  const format = "%H%x1f%P%x1f%at%x1f%B%x1e"
  const revision = options.baseCommit ? `${options.baseCommit}^@` : options.branch
  const before = exclusiveGitBefore(options.cutoffTime)
  const logArgs = [
    "log",
    `--format=${format}`,
    ...(options.since ? [`--since=${options.since}`] : []),
    ...(before ? [`--before=${before}`] : []),
    `--max-count=${options.maxCommits.toString()}`,
  ]
  const output = yield* git(worktree, [...logArgs, revision])
  const cutoff = options.cutoffTime ? Date.parse(options.cutoffTime) : undefined
  const candidates = output
    .split("\x1e")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, parents, authorTime, message] = line.split("\x1f")
      return { hash, parents, author_time: Number(authorTime) * 1000, message: (message ?? "").trim() }
    })
    .filter((commit) => commit.hash && (!cutoff || commit.author_time < cutoff))

  if (options.onProgress) yield* options.onProgress({ phase: "crawl", current: 0, total: candidates.length })
  const indexed: CommitInput[] = []
  let skipped = 0
  let current = 0
  for (const commit of candidates) {
    const changed_files = (yield* git(worktree, [
      "diff-tree",
      "-m",
      "--first-parent",
      "--no-commit-id",
      "--name-only",
      "-r",
      commit.hash,
    ]))
      .split("\n")
      .map((file) => file.trim())
      .filter((file) => file && !isExcludedPath(file))
    if (!changed_files.length || changed_files.length > options.maxFiles) {
      skipped++
      current++
      if (options.onProgress) yield* options.onProgress({ phase: "crawl", current, total: candidates.length })
      continue
    }
    const rawDiff = yield* git(worktree, [
      "show",
      "-m",
      "--first-parent",
      "--format=",
      "--no-ext-diff",
      "--unified=80",
      commit.hash,
      "--",
      ...changed_files,
    ])
    if (!rawDiff.includes("diff --git") || rawDiff.includes("Binary files ")) {
      skipped++
      current++
      if (options.onProgress) yield* options.onProgress({ phase: "crawl", current, total: candidates.length })
      continue
    }
    const diff = rawDiff.slice(0, DEFAULT_INDEX_LIMITS.maxDiffBytes)
    indexed.push({
      ...commit,
      branch: options.branch,
      base_commit: options.baseCommit,
      changed_files,
      diff,
      issue_number: options.noGithub ? undefined : parseIssueNumber(commit.message),
      token_text: tokenText([commit.message, changed_files.join(" "), diff].join("\n")),
    })
    current++
    if (options.onProgress) yield* options.onProgress({ phase: "crawl", current, total: candidates.length })
  }
  return { indexed, skipped }
})

function fileActivity(commits: readonly CommitInput[]) {
  const entries = new Map<
    string,
    { edit_count: number; last_modified: number; co_changed_files: Map<string, number> }
  >()
  for (const commit of commits) {
    for (const file of commit.changed_files) {
      const current = entries.get(file) ?? {
        edit_count: 0,
        last_modified: 0,
        co_changed_files: new Map<string, number>(),
      }
      current.edit_count++
      current.last_modified = Math.max(current.last_modified, commit.author_time)
      commit.changed_files
        .filter((candidate) => candidate !== file)
        .forEach((candidate) =>
          current.co_changed_files.set(candidate, (current.co_changed_files.get(candidate) ?? 0) + 1),
        )
      entries.set(file, current)
    }
  }
  return [...entries.entries()].map(([path, entry]) => ({
    path,
    edit_count: entry.edit_count,
    last_modified: entry.last_modified,
    co_changed_files: [...entry.co_changed_files.entries()]
      .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, DEFAULT_INDEX_LIMITS.topCoChangedFiles)
      .map(([file]) => file),
  }))
}

function isExcludedPath(file: string) {
  const parts = file.split("/")
  const name = parts[parts.length - 1]
  return (
    parts.some((part) => ["node_modules", ".git", "dist", "build", "coverage", "vendor"].includes(part)) ||
    name.endsWith(".lock") ||
    ["bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].includes(name) ||
    (parts[0] === "packages" &&
      parts[1] === "sdk" &&
      parts[2] === "js" &&
      (parts.includes("gen") || parts.includes("dist")))
  )
}

function parseIssueNumber(message: string) {
  return [
    /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/i,
    /\(#(\d+)\)/,
    /merge pull request #(\d+)\b/i,
  ]
    .map((pattern) => pattern.exec(message)?.[1])
    .map((issue) => (issue ? Number(issue) : undefined))
    .find((issue) => issue !== undefined && Number.isSafeInteger(issue) && issue > 0)
}

function readSummarySource(worktree: string, file: string) {
  return Effect.tryPromise({
    try: async () => {
      const content = await Bun.file(path.join(worktree, file)).text()
      return {
        content,
        source_hash: createHash("sha256").update(content).digest("hex"),
      }
    },
    catch: () => new Error(`Cannot read summary source: ${file}`),
  })
}

function worktreeSummarySource(worktree: string): SummarySourceReader {
  return (file) => readSummarySource(worktree, file)
}

function summarySourceFromCommits(worktree: string, commits: readonly CommitInput[]): SummarySourceReader {
  const files = new Map<string, { hash: string; author_time: number }>()
  for (const commit of commits) {
    for (const file of commit.changed_files) {
      const current = files.get(file)
      if (current && current.author_time >= commit.author_time) continue
      files.set(file, { hash: commit.hash, author_time: commit.author_time })
    }
  }
  return (file) => {
    const commit = files.get(file)
    if (!commit) return readSummarySource(worktree, file)
    return gitFileAtCommit(worktree, commit.hash, file)
  }
}

function gitFileAtCommit(worktree: string, commit: string, file: string) {
  return Effect.tryPromise({
    try: async () => {
      const result = await execFileAsync("git", ["show", `${commit}:${file}`], {
        cwd: worktree,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 10,
      })
      return {
        content: result.stdout,
        source_hash: createHash("sha256").update(result.stdout).digest("hex"),
      }
    },
    catch: () => new Error(`Cannot read summary source at ${commit}: ${file}`),
  })
}

function defaultSummaryGenerator() {
  return Effect.gen(function* () {
    const providerOption = yield* Effect.serviceOption(Provider.Service)
    if (Option.isNone(providerOption))
      return unavailableSummaryGenerator("No configured provider available for file summaries")
    const provider = providerOption.value
    const selected = yield* provider.defaultModel().pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!selected) return unavailableSummaryGenerator("No default model available for file summaries")
    const model = yield* provider
      .getModel(selected.providerID, selected.modelID)
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!model)
      return unavailableSummaryGenerator(
        `Model not found for file summaries: ${selected.providerID}/${selected.modelID}`,
      )
    const language = yield* provider.getLanguage(model).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!language)
      return unavailableSummaryGenerator(
        `Model unavailable for file summaries: ${selected.providerID}/${selected.modelID}`,
      )
    const authOption = yield* Effect.serviceOption(Auth.Service)
    const authInfo = Option.isSome(authOption)
      ? yield* authOption.value.get(model.providerID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      : undefined
    const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"
    return (input: SummaryGeneratorInput) =>
      Effect.tryPromise({
        try: async () => {
          const result = streamText({
            model: language,
            maxRetries: 0,
            ...(isOpenaiOauth ? {} : { maxOutputTokens: 1_200 }),
            providerOptions: isOpenaiOauth
              ? ProviderTransform.providerOptions(model, { instructions: SUMMARY_SYSTEM_PROMPT, store: false })
              : undefined,
            messages: [
              ...(isOpenaiOauth
                ? []
                : [
                    {
                      role: "system",
                      content: SUMMARY_SYSTEM_PROMPT,
                    } satisfies ModelMessage,
                  ]),
              {
                role: "user",
                content: summaryPrompt(input),
              },
            ],
          })
          let text = ""
          for await (const part of result.fullStream) {
            if (part.type === "error") throw part.error
            if (part.type === "text-delta") text += part.text
          }
          return { ...parseGeneratedSummary(text), model_id: `${model.providerID}/${model.id}` }
        },
        catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
      })
  })
}

function unavailableSummaryGenerator(message: string): SummaryGenerator {
  return () => Effect.fail(new Error(message))
}

function summaryPrompt(input: SummaryGeneratorInput) {
  return [
    `File: ${input.path}`,
    `Edit count: ${input.edit_count}`,
    `Co-changed files: ${input.co_changed_files.join(", ") || "none"}`,
    "Summarize the file for future code retrieval. Include responsibility, inputs/outputs, dependencies, common bug/change patterns, important symbols, and retrieval keywords.",
    'Return JSON: {"summary": string, "important_symbols": string[]}.',
    "Source:",
    input.content.slice(0, 40_000),
  ].join("\n")
}

function parseGeneratedSummary(text: string): SummaryGeneratorResult {
  const json = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)?.[1] ?? text.trim()
  try {
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== "object") return { summary: text.trim(), important_symbols: [] }
    const record = parsed as Record<string, unknown>
    return {
      summary: typeof record.summary === "string" ? record.summary : text.trim(),
      important_symbols: Array.isArray(record.important_symbols)
        ? record.important_symbols.filter((item): item is string => typeof item === "string")
        : [],
    }
  } catch {
    return { summary: text.trim(), important_symbols: [] }
  }
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

function exclusiveGitBefore(cutoffTime: string | undefined) {
  const cutoff = cutoffTime ? Date.parse(cutoffTime) : undefined
  if (!cutoff || Number.isNaN(cutoff)) return undefined
  return new Date(cutoff - 1_000).toISOString()
}

export * as Memory from "./memory"
