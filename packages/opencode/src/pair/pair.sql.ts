import { SessionTable } from "@/session/session.sql"
import { Timestamps } from "@/storage/schema.sql"
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const PairRoomTable = sqliteTable(
  "pair_room",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    host_peer_id: text().notNull(),
    status: text({ enum: ["active", "closed"] }).notNull().default("active"),
    driver_peer_id: text().notNull(),
    capabilities: text({ mode: "json" }).$type<string[]>().notNull(),
    closed_at: text(),
    ...Timestamps,
  },
  (table) => ({
    session_idx: index("pair_room_session_id_idx").on(table.session_id),
    status_idx: index("pair_room_status_idx").on(table.status),
  }),
)

export const PairPeerTable = sqliteTable(
  "pair_peer",
  {
    id: text().primaryKey(),
    room_id: text()
      .notNull()
      .references(() => PairRoomTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    role: text({ enum: ["host", "guest"] }).notNull(),
    status: text({ enum: ["invited", "connected", "disconnected", "left"] }).notNull().default("connected"),
    capabilities: text({ mode: "json" }).$type<string[]>().notNull(),
    last_seen_at: text().notNull(),
    ...Timestamps,
  },
  (table) => ({
    room_idx: index("pair_peer_room_id_idx").on(table.room_id),
    status_idx: index("pair_peer_status_idx").on(table.room_id, table.status),
  }),
)

export const PairInviteTable = sqliteTable(
  "pair_invite",
  {
    id: text().primaryKey(),
    room_id: text()
      .notNull()
      .references(() => PairRoomTable.id, { onDelete: "cascade" }),
    token_hash: text().notNull().unique(),
    capabilities: text({ mode: "json" }).$type<string[]>().notNull(),
    connection_profile: text({ mode: "json" }).$type<Record<string, unknown>>(),
    expires_at: text().notNull(),
    consumed_at: text(),
    ...Timestamps,
  },
  (table) => ({
    room_idx: index("pair_invite_room_id_idx").on(table.room_id),
    token_hash_idx: index("pair_invite_token_hash_idx").on(table.token_hash),
  }),
)
