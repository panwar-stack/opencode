import { desc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database, type TxOrDb } from "@/storage/db"
import {
  RepositoryMemoryCommitTable,
  RepositoryMemoryFileActivityTable,
  RepositoryMemoryFileSummaryTable,
  RepositoryMemoryRepositoryTable,
  RepositoryMemoryRetrievalLogTable,
} from "./memory.sql"
import { DEFAULT_LIMITS, rankDocuments } from "./search"
import { parseRepositoryReference, repositoryCacheIdentity, type Reference } from "@/util/repository"

const DEFAULT_CORPUS_LIMITS = {
  commits: 7_000,
  summaries: 200,
} as const

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

export interface Interface {
  readonly tables: {
    readonly repository: typeof RepositoryMemoryRepositoryTable
    readonly commit: typeof RepositoryMemoryCommitTable
    readonly fileActivity: typeof RepositoryMemoryFileActivityTable
    readonly fileSummary: typeof RepositoryMemoryFileSummaryTable
    readonly retrievalLog: typeof RepositoryMemoryRetrievalLogTable
  }
  readonly identity: (reference: string | Reference) => Effect.Effect<RepositoryIdentity>
  readonly getRepository: (identity: string) => Effect.Effect<typeof RepositoryMemoryRepositoryTable.$inferSelect | undefined>
  readonly ensureRepository: (input: RepositoryInput) => Effect.Effect<typeof RepositoryMemoryRepositoryTable.$inferSelect>
  readonly searchCommits: (input: { repository_id: string; query: string; limit?: number }) => Effect.Effect<ReturnType<typeof rankDocuments>>
  readonly searchSummaries: (input: { repository_id: string; query: string; limit?: number }) => Effect.Effect<ReturnType<typeof rankDocuments>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

export function identity(reference: string | Reference): RepositoryIdentity {
  const parsed = typeof reference === "string" ? parseRepositoryReference(reference) : reference
  if (!parsed) throw new Error("Repository must be a git URL, host/path reference, GitHub owner/repo shorthand, or file URL")
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
        d.select().from(RepositoryMemoryRepositoryTable).where(eq(RepositoryMemoryRepositoryTable.identity, repositoryIdentity)).get(),
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

    const searchSummaries = Effect.fn("Memory.searchSummaries")(function* (input: {
      repository_id: string
      query: string
      limit?: number
    }) {
      return rankDocuments(
        input.query,
        yield* db((d) =>
          d
            .select({ id: RepositoryMemoryFileSummaryTable.id, token_text: RepositoryMemoryFileSummaryTable.token_text })
            .from(RepositoryMemoryFileSummaryTable)
            .where(eq(RepositoryMemoryFileSummaryTable.repository_id, input.repository_id))
            .orderBy(desc(RepositoryMemoryFileSummaryTable.time_generated))
            .limit(DEFAULT_CORPUS_LIMITS.summaries)
            .all(),
        ),
        input.limit ?? DEFAULT_LIMITS.summaries,
      )
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
      searchCommits,
      searchSummaries,
    }
  }),
)

export const defaultLayer = layer

export * as Memory from "./memory"
