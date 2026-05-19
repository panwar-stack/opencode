import { and, eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { createHash } from "crypto"
import { Database } from "@/storage/db"
import {
  MemoryCitationTable,
  MemoryConstraintSourceTable,
  MemoryConstraintTable,
  MemoryRepositoryTable,
  MemorySourceItemTable,
  MemorySyncCheckpointTable,
} from "./memory.sql"
import { queryEntries } from "./search"
import type { Citation, QueryInput, QueryResult } from "."

export interface RepositoryInput {
  readonly id?: string
  readonly provider: string
  readonly repo: string
}

export interface SourceItemInput extends RepositoryInput {
  readonly source_id: string
  readonly source_kind: string
  readonly pr_number?: number
  readonly author?: string
  readonly url: string
  readonly path?: string
  readonly line?: number
  readonly position?: number
  readonly title?: string
  readonly labels?: readonly string[]
  readonly source_created_at?: number
  readonly source_updated_at?: number
  readonly source_cursor?: string
  readonly metadata?: Record<string, unknown>
}

export interface ConstraintInput extends RepositoryInput {
  readonly id?: string
  readonly title?: string
  readonly text: string
  readonly confidence?: number
  readonly status?: "active" | "stale"
  readonly files?: readonly string[]
  readonly directories?: readonly string[]
  readonly symbols?: readonly string[]
  readonly citations?: readonly Citation[]
  readonly source_items?: readonly SourceItemInput[]
}

export interface SyncCheckpointInput extends RepositoryInput {
  readonly cursor?: string
  readonly last_fetched_at?: number
  readonly fetch_options?: Record<string, unknown>
}

export interface SyncCheckpoint extends SyncCheckpointInput {
  readonly id: string
  readonly repository_id: string
}

type ConstraintRow = typeof MemoryConstraintTable.$inferSelect
type RepositoryRow = typeof MemoryRepositoryTable.$inferSelect
type SourceMetadata = Record<string, unknown>

export const upsertRepository = Effect.fn("MemoryIndex.upsertRepository")((input: RepositoryInput) =>
  Effect.sync(() =>
    Database.transaction((db) => {
      db.insert(MemoryRepositoryTable)
        .values({
          id: input.id ?? repositoryID(input),
          provider: input.provider,
          repo: input.repo,
        })
        .onConflictDoUpdate({
          target: [MemoryRepositoryTable.provider, MemoryRepositoryTable.repo],
          set: { provider: input.provider, repo: input.repo },
        })
        .run()

      return requireRepository(input)
    }),
  ),
)

export const upsertSourceItem = Effect.fn("MemoryIndex.upsertSourceItem")((input: SourceItemInput) =>
  Effect.sync(() =>
    Database.transaction((db) => {
      const repository = upsertRepositorySync(input)

      db.insert(MemorySourceItemTable)
        .values({
          id: sourceItemID(repository, input),
          repository_id: repository.id,
          provider: input.provider,
          source_id: input.source_id,
          source_kind: input.source_kind,
          pr_number: input.pr_number,
          author: input.author,
          url: input.url,
          path: input.path,
          line: input.line,
          position: input.position,
          title: input.title,
          labels: input.labels ? [...input.labels] : undefined,
          source_created_at: input.source_created_at,
          source_updated_at: input.source_updated_at,
          source_cursor: input.source_cursor,
          metadata: input.metadata,
        })
        .onConflictDoUpdate({
          target: [
            MemorySourceItemTable.repository_id,
            MemorySourceItemTable.provider,
            MemorySourceItemTable.source_id,
          ],
          set: {
            source_kind: input.source_kind,
            pr_number: input.pr_number,
            author: input.author,
            url: input.url,
            path: input.path,
            line: input.line,
            position: input.position,
            title: input.title,
            labels: input.labels ? [...input.labels] : undefined,
            source_created_at: input.source_created_at,
            source_updated_at: input.source_updated_at,
            source_cursor: input.source_cursor,
            metadata: input.metadata,
          },
        })
        .run()

      return db
        .select()
        .from(MemorySourceItemTable)
        .where(
          and(
            eq(MemorySourceItemTable.repository_id, repository.id),
            eq(MemorySourceItemTable.provider, input.provider),
            eq(MemorySourceItemTable.source_id, input.source_id),
          ),
        )
        .get()
    }),
  ),
)

export const upsertConstraint = Effect.fn("MemoryIndex.upsertConstraint")((input: ConstraintInput) =>
  Effect.sync(() =>
    Database.transaction((db) => {
      const repository = upsertRepositorySync(input)
      const existing = db
        .select()
        .from(MemoryConstraintTable)
        .where(and(eq(MemoryConstraintTable.repository_id, repository.id), eq(MemoryConstraintTable.text, input.text)))
        .get()
      const files = unique([...(existing?.files ?? []), ...(input.files ?? [])])
      const directories = unique([...(existing?.directories ?? []), ...(input.directories ?? [])])
      const symbols = unique([...(existing?.symbols ?? []), ...(input.symbols ?? [])])

      db.insert(MemoryConstraintTable)
        .values({
          id: input.id ?? constraintID(repository, input.text),
          repository_id: repository.id,
          title: input.title ?? titleFromText(input.text),
          text: input.text,
          confidence: Math.max(existing?.confidence ?? 0, input.confidence ?? 0),
          status: input.status ?? "active",
          files,
          directories,
          symbols,
        })
        .onConflictDoUpdate({
          target: [MemoryConstraintTable.repository_id, MemoryConstraintTable.text],
          set: {
            title: input.title ?? titleFromText(input.text),
            confidence: Math.max(existing?.confidence ?? 0, input.confidence ?? 0),
            status: input.status ?? "active",
            files,
            directories,
            symbols,
          },
        })
        .run()

      const constraint = requireConstraint(repository, input.text)

      for (const citation of input.citations ?? []) {
        db.insert(MemoryCitationTable)
          .values({
            id: citationID(constraint.id, citation.url),
            constraint_id: constraint.id,
            label: citation.label,
            url: citation.url,
          })
          .onConflictDoUpdate({
            target: [MemoryCitationTable.constraint_id, MemoryCitationTable.url],
            set: { label: citation.label },
          })
          .run()
      }

      for (const source of input.source_items ?? []) {
        const sourceItem = upsertSourceItemSync(source)
        if (!sourceItem) continue
        db.insert(MemoryConstraintSourceTable)
          .values({ constraint_id: constraint.id, source_item_id: sourceItem.id })
          .onConflictDoNothing()
          .run()
      }

      return toQueryResult(
        repository,
        constraint,
        citations([constraint.id]).get(constraint.id) ?? [],
        sourceMetadata([constraint.id]).get(constraint.id),
        0,
      )
    }),
  ),
)

export const upsertSyncCheckpoint = Effect.fn("MemoryIndex.upsertSyncCheckpoint")((input: SyncCheckpointInput) =>
  Effect.sync(() =>
    Database.transaction((db) => {
      const repository = upsertRepositorySync(input)

      db.insert(MemorySyncCheckpointTable)
        .values({
          id: syncCheckpointID(input),
          repository_id: repository.id,
          provider: input.provider,
          repo: input.repo,
          cursor: input.cursor,
          last_fetched_at: input.last_fetched_at,
          fetch_options: input.fetch_options,
        })
        .onConflictDoUpdate({
          target: [MemorySyncCheckpointTable.provider, MemorySyncCheckpointTable.repo],
          set: {
            repository_id: repository.id,
            cursor: input.cursor,
            last_fetched_at: input.last_fetched_at,
            fetch_options: input.fetch_options,
          },
        })
        .run()
    }),
  ).pipe(Effect.asVoid),
)

export const getSyncCheckpoint = Effect.fn("MemoryIndex.getSyncCheckpoint")((input: RepositoryInput) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .select()
        .from(MemorySyncCheckpointTable)
        .where(
          and(eq(MemorySyncCheckpointTable.provider, input.provider), eq(MemorySyncCheckpointTable.repo, input.repo)),
        )
        .get(),
    ),
  ),
)

export const query = Effect.fn("MemoryIndex.query")((input: QueryInput) =>
  Effect.sync(() =>
    Database.use((db) => {
      const rows = db
        .select({
          constraint: MemoryConstraintTable,
          repository: MemoryRepositoryTable,
        })
        .from(MemoryConstraintTable)
        .innerJoin(MemoryRepositoryTable, eq(MemoryConstraintTable.repository_id, MemoryRepositoryTable.id))
        .where(
          input.repo
            ? and(eq(MemoryConstraintTable.status, "active"), eq(MemoryRepositoryTable.repo, input.repo))
            : eq(MemoryConstraintTable.status, "active"),
        )
        .all()

      const citationByConstraint = citations(rows.map((row) => row.constraint.id))
      const metadataByConstraint = sourceMetadata(rows.map((row) => row.constraint.id))

      return queryEntries(
        rows.map((row) =>
          toQueryResult(
            row.repository,
            row.constraint,
            citationByConstraint.get(row.constraint.id) ?? [],
            metadataByConstraint.get(row.constraint.id),
            0,
          ),
        ),
        input,
      )
    }),
  ),
)

export const clear = Effect.fn("MemoryIndex.clear")(() =>
  Effect.sync(() =>
    Database.transaction((db) => {
      db.delete(MemoryRepositoryTable).run()
    }),
  ).pipe(Effect.asVoid),
)

export const clearRepository = Effect.fn("MemoryIndex.clearRepository")((input: RepositoryInput) =>
  Effect.sync(() =>
    Database.transaction((db) => {
      db.delete(MemoryRepositoryTable)
        .where(and(eq(MemoryRepositoryTable.provider, input.provider), eq(MemoryRepositoryTable.repo, input.repo)))
        .run()
    }),
  ).pipe(Effect.asVoid),
)

function upsertRepositorySync(input: RepositoryInput) {
  Database.use((db) =>
    db
      .insert(MemoryRepositoryTable)
      .values({ id: input.id ?? repositoryID(input), provider: input.provider, repo: input.repo })
      .onConflictDoUpdate({
        target: [MemoryRepositoryTable.provider, MemoryRepositoryTable.repo],
        set: { provider: input.provider, repo: input.repo },
      })
      .run(),
  )
  return requireRepository(input)
}

function upsertSourceItemSync(input: SourceItemInput) {
  return Effect.runSync(upsertSourceItem(input))
}

function requireRepository(input: RepositoryInput) {
  const row = Database.use((db) =>
    db
      .select()
      .from(MemoryRepositoryTable)
      .where(and(eq(MemoryRepositoryTable.provider, input.provider), eq(MemoryRepositoryTable.repo, input.repo)))
      .get(),
  )
  if (!row) throw new Error(`Missing memory repository ${input.provider}/${input.repo}`)
  return row
}

function requireConstraint(repository: RepositoryRow, text: string) {
  const row = Database.use((db) =>
    db
      .select()
      .from(MemoryConstraintTable)
      .where(and(eq(MemoryConstraintTable.repository_id, repository.id), eq(MemoryConstraintTable.text, text)))
      .get(),
  )
  if (!row) throw new Error(`Missing memory constraint ${repository.provider}/${repository.repo}`)
  return row
}

function citations(constraintIDs: readonly string[]) {
  if (constraintIDs.length === 0) return new Map<string, Citation[]>()

  return Database.use((db) =>
    db
      .select()
      .from(MemoryCitationTable)
      .where(inArray(MemoryCitationTable.constraint_id, [...constraintIDs]))
      .all(),
  ).reduce((acc, row) => {
    acc.set(row.constraint_id, [...(acc.get(row.constraint_id) ?? []), { label: row.label, url: row.url }])
    return acc
  }, new Map<string, Citation[]>())
}

function sourceMetadata(constraintIDs: readonly string[]) {
  if (constraintIDs.length === 0) return new Map<string, SourceMetadata>()

  return Database.use((db) =>
    db
      .select({
        constraint_id: MemoryConstraintSourceTable.constraint_id,
        metadata: MemorySourceItemTable.metadata,
      })
      .from(MemoryConstraintSourceTable)
      .innerJoin(MemorySourceItemTable, eq(MemoryConstraintSourceTable.source_item_id, MemorySourceItemTable.id))
      .where(inArray(MemoryConstraintSourceTable.constraint_id, [...constraintIDs]))
      .all(),
  ).reduce((acc, row) => {
    if (!row.metadata) return acc
    const current = acc.get(row.constraint_id)
    if (current && prStateWeight(current) >= prStateWeight(row.metadata)) return acc
    acc.set(row.constraint_id, row.metadata)
    return acc
  }, new Map<string, SourceMetadata>())
}

function toQueryResult(
  repository: RepositoryRow,
  constraint: ConstraintRow,
  citations: readonly Citation[],
  metadata: SourceMetadata | undefined,
  score: number,
): QueryResult {
  return {
    id: constraint.id,
    provider: repository.provider,
    repo: repository.repo,
    title: constraint.title,
    body: constraint.text,
    file: constraint.files[0],
    files: constraint.files,
    confidence: constraint.confidence,
    citations,
    ...(metadata ? { metadata } : {}),
    score,
  }
}

function prStateWeight(metadata: SourceMetadata | undefined) {
  const pr = metadata?.pr
  if (!pr || typeof pr !== "object") return 0
  if (!("state" in pr) || pr.state !== "closed") return 0
  if (!("merged" in pr)) return 0
  if (pr.merged === true) return 30
  if (pr.merged === false) return 15
  return 0
}

function titleFromText(text: string) {
  const title = text.split("\n").find(Boolean) ?? text
  if (title.length <= 80) return title
  return `${title.slice(0, 77)}...`
}

function repositoryID(input: RepositoryInput) {
  return `memory_repository:${hash(`${input.provider}:${input.repo}`)}`
}

function sourceItemID(repository: RepositoryRow, input: SourceItemInput) {
  return `memory_source_item:${hash(`${repository.id}:${input.provider}:${input.source_id}`)}`
}

function constraintID(repository: RepositoryRow, text: string) {
  return `memory_constraint:${hash(`${repository.id}:${text}`)}`
}

function citationID(constraintID: string, url: string) {
  return `memory_citation:${hash(`${constraintID}:${url}`)}`
}

function syncCheckpointID(input: SyncCheckpointInput) {
  return `memory_sync_checkpoint:${hash(`${input.provider}:${input.repo}`)}`
}

function hash(input: string) {
  return createHash("sha256").update(input).digest("hex").slice(0, 24)
}

function unique(input: readonly string[]) {
  return [...new Set(input)]
}

export * as MemoryIndex from "./repo"
