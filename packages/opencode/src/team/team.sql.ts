import { sql } from "drizzle-orm"
import { text, integer, sqliteTable, uniqueIndex, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "@/storage/schema.sql"

export const TeamTable = sqliteTable(
  "team",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    goal: text().notNull(),
    lead_session_id: text().notNull(),
    status: text({ enum: ["active", "closed", "cancelled"] })
      .notNull()
      .default("active"),
    ...Timestamps,
  },
  (table) => ({
    lead_session_idx: uniqueIndex("team_active_lead_session_idx")
      .on(table.lead_session_id)
      .where(sql`${table.status} = 'active'`),
  }),
)

export const TeamMemberTable = sqliteTable(
  "team_member",
  {
    id: text().primaryKey(),
    team_id: text().notNull(),
    session_id: text().notNull(),
    name: text().notNull(),
    agent_type: text().notNull(),
    model: text({ mode: "json" }).$type<{ providerID: string; modelID: string } | null>(),
    role_prompt: text().notNull(),
    status: text({ enum: ["starting", "blocked", "active", "idle", "completed", "cancelled"] })
      .notNull()
      .default("starting"),
    plan_mode: integer({ mode: "boolean" }).notNull().default(false),
    work_mode: text({ enum: ["plan", "implement"] })
      .notNull()
      .default("implement"),
    dependency_ids: text({ mode: "json" }).$type<string[] | null>(),
    result: text(),
    ...Timestamps,
  },
  (table) => ({
    team_idx: uniqueIndex("team_member_team_idx").on(table.team_id, table.session_id),
    session_idx: uniqueIndex("team_member_session_idx").on(table.session_id),
  }),
)

export const TeamTaskTable = sqliteTable(
  "team_task",
  {
    id: text().primaryKey(),
    team_id: text().notNull(),
    description: text().notNull(),
    status: text({ enum: ["pending", "in_progress", "completed", "cancelled"] })
      .notNull()
      .default("pending"),
    assignee: text(),
    dependency_ids: text({ mode: "json" }).$type<string[] | null>(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown> | null>(),
    ...Timestamps,
  },
  (table) => ({
    team_idx: uniqueIndex("team_task_team_idx").on(table.team_id, table.id),
  }),
)

export const TeamMessageTable = sqliteTable(
  "team_message",
  {
    id: text().primaryKey(),
    team_id: text().notNull(),
    sender: text().notNull(),
    recipients: text({ mode: "json" }).$type<string[]>().notNull(),
    body: text().notNull(),
    delivery_status: text({ enum: ["pending", "delivered", "read"] })
      .notNull()
      .default("pending"),
    ...Timestamps,
  },
  (table) => ({
    team_idx: uniqueIndex("team_message_team_idx").on(table.team_id, table.id),
    recipient_idx: index("team_message_recipient_idx").on(table.team_id, table.delivery_status),
  }),
)

export const TeamMessageRecipientTable = sqliteTable(
  "team_message_recipient",
  {
    id: text().primaryKey(),
    message_id: text().notNull(),
    team_id: text().notNull(),
    recipient: text().notNull(),
    delivery_status: text({ enum: ["pending", "delivered", "read"] })
      .notNull()
      .default("pending"),
    ...Timestamps,
  },
  (table) => ({
    message_recipient_idx: uniqueIndex("team_message_recipient_message_idx").on(table.message_id, table.recipient),
    recipient_idx: index("team_message_recipient_status_idx").on(table.team_id, table.recipient, table.delivery_status),
  }),
)
