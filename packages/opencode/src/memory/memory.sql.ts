import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "@/storage/schema.sql"

export const MemoryRepositoryTable = sqliteTable(
  "memory_repository",
  {
    id: text().primaryKey(),
    provider: text().notNull(),
    repo: text().notNull(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("memory_repository_provider_repo_idx").on(table.provider, table.repo)],
)

export const MemorySourceItemTable = sqliteTable(
  "memory_source_item",
  {
    id: text().primaryKey(),
    repository_id: text()
      .notNull()
      .references(() => MemoryRepositoryTable.id, { onDelete: "cascade" }),
    provider: text().notNull(),
    source_id: text().notNull(),
    source_kind: text().notNull(),
    pr_number: integer(),
    author: text(),
    url: text().notNull(),
    path: text(),
    line: integer(),
    position: integer(),
    title: text(),
    labels: text({ mode: "json" }).$type<string[]>(),
    source_created_at: integer(),
    source_updated_at: integer(),
    source_cursor: text(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("memory_source_item_repository_provider_source_idx").on(
      table.repository_id,
      table.provider,
      table.source_id,
    ),
    index("memory_source_item_repository_path_idx").on(table.repository_id, table.path),
    index("memory_source_item_repository_pr_idx").on(table.repository_id, table.pr_number),
  ],
)

export const MemoryConstraintTable = sqliteTable(
  "memory_constraint",
  {
    id: text().primaryKey(),
    repository_id: text()
      .notNull()
      .references(() => MemoryRepositoryTable.id, { onDelete: "cascade" }),
    title: text().notNull(),
    text: text().notNull(),
    confidence: real().notNull().default(0),
    status: text({ enum: ["active", "stale"] })
      .notNull()
      .default("active"),
    files: text({ mode: "json" }).notNull().$type<string[]>(),
    directories: text({ mode: "json" }).notNull().$type<string[]>(),
    symbols: text({ mode: "json" }).notNull().$type<string[]>(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("memory_constraint_repository_text_idx").on(table.repository_id, table.text),
    index("memory_constraint_repository_status_idx").on(table.repository_id, table.status),
    index("memory_constraint_repository_time_updated_idx").on(table.repository_id, table.time_updated),
  ],
)

export const MemoryConstraintSourceTable = sqliteTable(
  "memory_constraint_source",
  {
    constraint_id: text()
      .notNull()
      .references(() => MemoryConstraintTable.id, { onDelete: "cascade" }),
    source_item_id: text()
      .notNull()
      .references(() => MemorySourceItemTable.id, { onDelete: "cascade" }),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.constraint_id, table.source_item_id] }),
    index("memory_constraint_source_item_idx").on(table.source_item_id),
  ],
)

export const MemoryCitationTable = sqliteTable(
  "memory_citation",
  {
    id: text().primaryKey(),
    constraint_id: text()
      .notNull()
      .references(() => MemoryConstraintTable.id, { onDelete: "cascade" }),
    label: text().notNull(),
    url: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("memory_citation_constraint_url_idx").on(table.constraint_id, table.url),
    index("memory_citation_constraint_idx").on(table.constraint_id),
  ],
)

export const MemorySyncCheckpointTable = sqliteTable(
  "memory_sync_checkpoint",
  {
    id: text().primaryKey(),
    repository_id: text()
      .notNull()
      .references(() => MemoryRepositoryTable.id, { onDelete: "cascade" }),
    provider: text().notNull(),
    repo: text().notNull(),
    cursor: text(),
    last_fetched_at: integer(),
    fetch_options: text({ mode: "json" }).$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("memory_sync_checkpoint_provider_repo_idx").on(table.provider, table.repo)],
)
