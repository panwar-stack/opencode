import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { Timestamps } from "@/storage/schema.sql"

export const workflow = sqliteTable("workflow", {
  id: text().primaryKey(),
  title: text().notNull(),
  status: text().notNull(),
  request: text().notNull(),
  spec_version: integer().notNull().default(0),
  approved_spec_hash: text(),
  approved_plan_commit: text(),
  plan_pr_number: integer(),
  plan_pr_url: text(),
  plan_pr_branch: text(),
  plan_pr_commit: text(),
  plan_review_state: text().default("pending"),
  code_pr_number: integer(),
  code_pr_url: text(),
  code_pr_branch: text(),
  code_pr_commit: text(),
  code_review_state: text().default("pending"),
  current_task_id: text(),
  max_steps: integer().default(50),
  step_count: integer().default(0),
  project_id: text().notNull(),
  directory: text().notNull(),
  ...Timestamps,
})

export const workflow_session = sqliteTable("workflow_session", {
  id: text().primaryKey(),
  workflow_id: text().notNull(),
  session_id: text().notNull(),
  role: text().notNull(),
  agent: text().notNull(),
  status: text().notNull(),
  current_task_id: text(),
  files_touched: text({ mode: "json" }).$type<string[]>(),
  needs_input: integer({ mode: "boolean" }).default(false),
  related_comment_id: integer(),
  related_comment_url: text(),
  ...Timestamps,
})

export const workflow_decision = sqliteTable("workflow_decision", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  workflow_id: text().notNull(),
  session_id: text(),
  actor: text().notNull(),
  type: text().notNull(),
  previous_state: text(),
  new_state: text(),
  reason: text(),
  evidence: text(),
  pull_request: integer(),
  comment_url: text(),
  time: text().notNull(),
})

export const workflow_github_comment = sqliteTable("workflow_github_comment", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  workflow_id: text().notNull(),
  comment_id: integer().notNull(),
  pull_request_type: text().notNull(),
  pull_request_number: integer().notNull(),
  url: text().notNull(),
  body: text(),
  author: text(),
  status: text().notNull().default("open"),
  assigned_session_id: text(),
  github_created_at: text(),
  ...Timestamps,
})
