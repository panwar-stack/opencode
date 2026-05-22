import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"

export const RepositoryMemoryRepositoryTable = sqliteTable(
  "repository_memory_repository",
  {
    id: text().primaryKey(),
    identity: text().notNull().unique(),
    provider: text(),
    owner: text(),
    name: text(),
    default_branch: text(),
    base_commit: text(),
    ...Timestamps,
  },
)

export const RepositoryMemoryCommitTable = sqliteTable(
  "repository_memory_commit",
  {
    id: text().primaryKey(),
    repository_id: text()
      .notNull()
      .references(() => RepositoryMemoryRepositoryTable.id, { onDelete: "cascade" }),
    hash: text().notNull(),
    message: text().notNull(),
    author_time: integer().notNull(),
    branch: text(),
    base_commit: text(),
    changed_files: text().notNull(),
    diff: text().notNull(),
    issue_number: integer(),
    issue_title: text(),
    issue_body: text(),
    token_text: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("repository_memory_commit_repository_id_hash_idx").on(table.repository_id, table.hash),
    index("repository_memory_commit_repository_id_author_time_idx").on(table.repository_id, table.author_time),
  ],
)

export const RepositoryMemoryFileActivityTable = sqliteTable(
  "repository_memory_file_activity",
  {
    id: text().primaryKey(),
    repository_id: text()
      .notNull()
      .references(() => RepositoryMemoryRepositoryTable.id, { onDelete: "cascade" }),
    path: text().notNull(),
    edit_count: integer().notNull(),
    last_modified: integer(),
    co_changed_files: text().notNull(),
    ...Timestamps,
  },
  (table) => [index("repository_memory_file_activity_repository_id_path_idx").on(table.repository_id, table.path)],
)

export const RepositoryMemoryFileSummaryTable = sqliteTable(
  "repository_memory_file_summary",
  {
    id: text().primaryKey(),
    repository_id: text()
      .notNull()
      .references(() => RepositoryMemoryRepositoryTable.id, { onDelete: "cascade" }),
    path: text().notNull(),
    source_hash: text().notNull(),
    summary: text().notNull(),
    important_symbols: text().notNull(),
    token_text: text().notNull(),
    model_id: text(),
    time_generated: integer().notNull(),
    ...Timestamps,
  },
  (table) => [index("repository_memory_file_summary_repository_id_path_idx").on(table.repository_id, table.path)],
)

export const RepositoryMemoryRetrievalLogTable = sqliteTable(
  "repository_memory_retrieval_log",
  {
    id: text().primaryKey(),
    repository_id: text()
      .notNull()
      .references(() => RepositoryMemoryRepositoryTable.id, { onDelete: "cascade" }),
    session_id: text(),
    issue_identifier: text(),
    tool: text().notNull(),
    query: text().notNull(),
    returned_items: text().notNull(),
    selected_items: text(),
    final_files: text(),
    outcome: text(),
    ...Timestamps,
  },
  (table) => [index("repository_memory_retrieval_log_repository_id_session_id_idx").on(table.repository_id, table.session_id)],
)
