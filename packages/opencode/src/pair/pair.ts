export * as Pair from "./pair"

import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import { Database, and, eq } from "@/storage/db"
import { Context, Duration, Effect, Layer, Option, Schema } from "effect"
import { createHash, randomBytes } from "crypto"
import { ConnectionProfile, InviteLink } from "./connection-profile"
import { PairCredential } from "./credential"
import { PairInviteTable, PairPeerTable, PairRoomTable } from "./pair.sql"

export const Capability = Schema.Literals([
  "view_session",
  "view_files",
  "send_prompt",
  "request_control",
  "control_driver",
  "edit_files",
  "run_shell",
  "approve_permissions",
  "share_terminal",
])
export type Capability = Schema.Schema.Type<typeof Capability>

export const DEFAULT_GUEST_CAPABILITIES = [
  "view_session",
  "view_files",
  "send_prompt",
  "request_control",
] satisfies Capability[]

export const DEFAULT_HOST_CAPABILITIES = [
  "view_session",
  "view_files",
  "send_prompt",
  "request_control",
  "control_driver",
  "edit_files",
  "run_shell",
  "approve_permissions",
  "share_terminal",
] satisfies Capability[]

const SAFE_GUEST_CAPABILITIES = ["view_session", "view_files", "send_prompt", "request_control"] satisfies Capability[]

export const PeerInfo = Schema.Struct({
  id: Schema.String,
  roomID: Schema.String,
  name: Schema.String,
  role: Schema.Literals(["host", "guest"]),
  status: Schema.Literals(["invited", "connected", "disconnected", "left"]),
  capabilities: Schema.mutable(Schema.Array(Capability)),
  lastSeenAt: Schema.String,
  time: Schema.Struct({
    created: Schema.Number,
    updated: Schema.Number,
  }),
})
export type PeerInfo = Schema.Schema.Type<typeof PeerInfo>

export const RoomInfo = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  hostPeerID: Schema.String,
  status: Schema.Literals(["active", "closed"]),
  driverPeerID: Schema.String,
  capabilities: Schema.mutable(Schema.Array(Capability)),
  closedAt: Schema.NullOr(Schema.String),
  time: Schema.Struct({
    created: Schema.Number,
    updated: Schema.Number,
  }),
})
export type RoomInfo = Schema.Schema.Type<typeof RoomInfo>

export const InviteInfo = Schema.Struct({
  id: Schema.String,
  roomID: Schema.String,
  token: Schema.String,
  capabilities: Schema.mutable(Schema.Array(Capability)),
  connectionProfile: Schema.optional(ConnectionProfile),
  expiresAt: Schema.String,
  consumedAt: Schema.NullOr(Schema.String),
  time: Schema.Struct({
    created: Schema.Number,
    updated: Schema.Number,
  }),
})
export type InviteInfo = Schema.Schema.Type<typeof InviteInfo>

export const JoinInfo = Schema.Struct({
  room: RoomInfo,
  peer: PeerInfo,
  credential: Schema.optional(PairCredential.Credential),
})
export type JoinInfo = Schema.Schema.Type<typeof JoinInfo>

export class RoomNotFoundError extends Schema.TaggedErrorClass<RoomNotFoundError>()("Pair.RoomNotFoundError", {
  roomID: Schema.String,
}) {}

export class PeerNotFoundError extends Schema.TaggedErrorClass<PeerNotFoundError>()("Pair.PeerNotFoundError", {
  roomID: Schema.String,
  peerID: Schema.String,
}) {}

export class InviteNotFoundError extends Schema.TaggedErrorClass<InviteNotFoundError>()("Pair.InviteNotFoundError", {}) {}

export class InviteExpiredError extends Schema.TaggedErrorClass<InviteExpiredError>()("Pair.InviteExpiredError", {
  inviteID: Schema.String,
}) {}

export class InviteConsumedError extends Schema.TaggedErrorClass<InviteConsumedError>()("Pair.InviteConsumedError", {
  inviteID: Schema.String,
}) {}

export class UnauthorizedError extends Schema.TaggedErrorClass<UnauthorizedError>()("Pair.UnauthorizedError", {
  roomID: Schema.String,
  peerID: Schema.String,
  capability: Capability,
}) {}

export class PairCredentialIssueError extends Schema.TaggedErrorClass<PairCredentialIssueError>()("Pair.CredentialIssueError", {
  roomID: Schema.String,
  peerID: Schema.String,
}) {}

export const Event = {
  RoomCreated: BusEvent.define(
    "pair.room.created",
    Schema.Struct({ roomID: Schema.String, sessionID: SessionID, hostPeerID: Schema.String }),
  ),
  RoomClosed: BusEvent.define("pair.room.closed", Schema.Struct({ roomID: Schema.String })),
  PeerJoined: BusEvent.define(
    "pair.peer.joined",
    Schema.Struct({ roomID: Schema.String, peerID: Schema.String, role: Schema.Literals(["host", "guest"]) }),
  ),
  PeerLeft: BusEvent.define("pair.peer.left", Schema.Struct({ roomID: Schema.String, peerID: Schema.String })),
  ControlRequested: BusEvent.define(
    "pair.control.requested",
    Schema.Struct({ roomID: Schema.String, peerID: Schema.String }),
  ),
  ControlGranted: BusEvent.define(
    "pair.control.granted",
    Schema.Struct({ roomID: Schema.String, peerID: Schema.String }),
  ),
  ControlRevoked: BusEvent.define(
    "pair.control.revoked",
    Schema.Struct({ roomID: Schema.String, peerID: Schema.String }),
  ),
  RemoteSubmitted: BusEvent.define(
    "pair.remote.submitted",
    Schema.Struct({ roomID: Schema.String, peerID: Schema.String }),
  ),
  PresenceUpdated: BusEvent.define(
    "pair.presence.updated",
    Schema.Struct({ roomID: Schema.String, peerID: Schema.String, status: Schema.String }),
  ),
  CursorUpdated: BusEvent.define(
    "pair.cursor.updated",
    Schema.Struct({
      roomID: Schema.String,
      peerID: Schema.String,
      path: Schema.String,
      line: Schema.Number,
      column: Schema.Number,
    }),
  ),
  SelectionUpdated: BusEvent.define(
    "pair.selection.updated",
    Schema.Struct({ roomID: Schema.String, peerID: Schema.String, path: Schema.String }),
  ),
  PromptUpdated: BusEvent.define(
    "pair.prompt.updated",
    Schema.Struct({ roomID: Schema.String, peerID: Schema.String, text: Schema.String }),
  ),
  TypingUpdated: BusEvent.define(
    "pair.typing.updated",
    Schema.Struct({ roomID: Schema.String, peerID: Schema.String, typing: Schema.Boolean }),
  ),
  ConnectionUpdated: BusEvent.define(
    "pair.connection.updated",
    Schema.Struct({ roomID: Schema.String, peerID: Schema.String, status: Schema.String }),
  ),
}

export interface Interface {
  createRoom(input: { sessionID: SessionID; hostName?: string; capabilities?: Capability[] }): Effect.Effect<RoomInfo>
  getRoom(roomID: string): Effect.Effect<Option.Option<RoomInfo>>
  issueInvite(input: {
    roomID: string
    actorPeerID: string
    capabilities?: Capability[]
    connectionProfile?: ConnectionProfile
    ttl?: Duration.Input
  }): Effect.Effect<InviteInfo, PeerNotFoundError | RoomNotFoundError | UnauthorizedError>
  resolveInviteLink(input: {
    roomID: string
    actorPeerID: string
    connectionProfile?: ConnectionProfile
    capabilities?: Capability[]
    ttl?: Duration.Input
  }): Effect.Effect<InviteLink, PeerNotFoundError | RoomNotFoundError | UnauthorizedError>
  join(input: {
    inviteToken: string
    name: string
  }): Effect.Effect<JoinInfo, InviteNotFoundError | InviteExpiredError | InviteConsumedError | RoomNotFoundError | PeerNotFoundError | PairCredentialIssueError>
  leave(input: { roomID: string; peerID: string; actorPeerID: string }): Effect.Effect<void, PeerNotFoundError | RoomNotFoundError | UnauthorizedError>
  closeRoom(input: { roomID: string; actorPeerID: string }): Effect.Effect<void, PeerNotFoundError | RoomNotFoundError | UnauthorizedError>
  requestControl(input: { roomID: string; peerID: string }): Effect.Effect<void, PeerNotFoundError | RoomNotFoundError | UnauthorizedError>
  grantControl(input: {
    roomID: string
    peerID: string
    actorPeerID: string
  }): Effect.Effect<RoomInfo, PeerNotFoundError | RoomNotFoundError | UnauthorizedError>
  revokeControl(input: {
    roomID: string
    peerID: string
    actorPeerID: string
  }): Effect.Effect<RoomInfo, PeerNotFoundError | RoomNotFoundError | UnauthorizedError>
  authorize(input: { roomID: string; peerID: string; capability: Capability }): Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Pair") {}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

function createInviteToken() {
  return randomBytes(32).toString("base64url")
}

function roomFromRow(row: typeof PairRoomTable.$inferSelect): RoomInfo {
  return {
    id: row.id,
    sessionID: SessionID.descending(row.session_id),
    hostPeerID: row.host_peer_id,
    status: row.status,
    driverPeerID: row.driver_peer_id,
    capabilities: row.capabilities as Capability[],
    closedAt: row.closed_at,
    time: { created: row.time_created, updated: row.time_updated },
  }
}

function peerFromRow(row: typeof PairPeerTable.$inferSelect): PeerInfo {
  return {
    id: row.id,
    roomID: row.room_id,
    name: row.name,
    role: row.role,
    status: row.status,
    capabilities: row.capabilities as Capability[],
    lastSeenAt: row.last_seen_at,
    time: { created: row.time_created, updated: row.time_updated },
  }
}

function inviteFromRow(row: typeof PairInviteTable.$inferSelect, token: string): InviteInfo {
  return {
    id: row.id,
    roomID: row.room_id,
    token,
    capabilities: row.capabilities as Capability[],
    connectionProfile: row.connection_profile ? (row.connection_profile as ConnectionProfile) : undefined,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    time: { created: row.time_created, updated: row.time_updated },
  }
}

export const layer: Layer.Layer<Service, never, Bus.Service | PairCredential.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const credSvc = yield* PairCredential.Service
    
    const getRoomRow = (roomID: string) =>
      Database.use((db) => db.select().from(PairRoomTable).where(eq(PairRoomTable.id, roomID)).get())

    const getPeerRow = (roomID: string, peerID: string) =>
      Database.use((db) =>
        db.select().from(PairPeerTable).where(and(eq(PairPeerTable.room_id, roomID), eq(PairPeerTable.id, peerID))).get(),
      )

    const ensureRoom = Effect.fnUntraced(function* (roomID: string) {
      const row = getRoomRow(roomID)
      if (!row) return yield* new RoomNotFoundError({ roomID })
      return row
    })

    const ensureActiveRoom = Effect.fnUntraced(function* (roomID: string) {
      const row = yield* ensureRoom(roomID)
      if (row.status !== "active") return yield* new RoomNotFoundError({ roomID })
      return row
    })

    const ensurePeer = Effect.fnUntraced(function* (roomID: string, peerID: string) {
      const row = getPeerRow(roomID, peerID)
      if (!row) return yield* new PeerNotFoundError({ roomID, peerID })
      return row
    })

    const ensureConnectedPeer = Effect.fnUntraced(function* (roomID: string, peerID: string) {
      const row = yield* ensurePeer(roomID, peerID)
      if (row.status !== "connected") return yield* new PeerNotFoundError({ roomID, peerID })
      return row
    })

    const ensureControlAuthority = Effect.fnUntraced(function* (
      room: typeof PairRoomTable.$inferSelect,
      actor: typeof PairPeerTable.$inferSelect,
    ) {
      if (actor.id === room.host_peer_id || actor.id === room.driver_peer_id || actor.capabilities.includes("control_driver")) return
      return yield* new UnauthorizedError({ roomID: room.id, peerID: actor.id, capability: "control_driver" })
    })

    const createRoom = Effect.fn("Pair.createRoom")(function* (input: {
      sessionID: SessionID
      hostName?: string
      capabilities?: Capability[]
    }) {
      const id = crypto.randomUUID()
      const peerID = crypto.randomUUID()
      const now = Date.now()
      const lastSeenAt = new Date(now).toISOString()
      const capabilities = input.capabilities ?? DEFAULT_HOST_CAPABILITIES
      Database.transaction((db) => {
        db.insert(PairRoomTable)
          .values({
            id,
            session_id: input.sessionID,
            host_peer_id: peerID,
            status: "active",
            driver_peer_id: peerID,
            capabilities,
            closed_at: null,
            time_created: now,
            time_updated: now,
          })
          .run()
        db.insert(PairPeerTable)
          .values({
            id: peerID,
            room_id: id,
            name: input.hostName ?? "Host",
            role: "host",
            status: "connected",
            capabilities,
            last_seen_at: lastSeenAt,
            time_created: now,
            time_updated: now,
          })
          .run()
      })
      yield* bus.publish(Event.RoomCreated, { roomID: id, sessionID: input.sessionID, hostPeerID: peerID })
      yield* bus.publish(Event.PeerJoined, { roomID: id, peerID, role: "host" })
      return roomFromRow(getRoomRow(id)!)
    })

    const getRoom = Effect.fn("Pair.getRoom")(function* (roomID: string) {
      const row = getRoomRow(roomID)
      if (!row) return Option.none()
      return Option.some(roomFromRow(row))
    })

    const issueInvite = Effect.fn("Pair.issueInvite")(function* (input: {
      roomID: string
      actorPeerID: string
      capabilities?: Capability[]
      connectionProfile?: ConnectionProfile
      ttl?: Duration.Input
    }) {
      const room = yield* ensureActiveRoom(input.roomID)
      const actor = yield* ensureConnectedPeer(input.roomID, input.actorPeerID)
      yield* ensureControlAuthority(room, actor)
      const id = crypto.randomUUID()
      const token = createInviteToken()
      const now = Date.now()
      const expiresAt = new Date(now + Duration.toMillis(Duration.fromInputUnsafe(input.ttl ?? Duration.minutes(15)))).toISOString()
      const capabilities = input.capabilities ?? DEFAULT_GUEST_CAPABILITIES
      const unauthorized = capabilities.find(
        (capability) =>
          !SAFE_GUEST_CAPABILITIES.some((item) => item === capability) ||
          !room.capabilities.includes(capability) ||
          !actor.capabilities.includes(capability),
      )
      if (unauthorized) {
        return yield* new UnauthorizedError({ roomID: input.roomID, peerID: input.actorPeerID, capability: unauthorized })
      }
      Database.use((db) =>
        db
          .insert(PairInviteTable)
          .values({
            id,
            room_id: input.roomID,
            token_hash: hashToken(token),
            capabilities,
            connection_profile: input.connectionProfile ? (input.connectionProfile as Record<string, unknown>) : null,
            expires_at: expiresAt,
            consumed_at: null,
            time_created: now,
            time_updated: now,
          })
          .run(),
      )
      return inviteFromRow(
        {
          id,
          room_id: input.roomID,
          token_hash: hashToken(token),
          capabilities,
          connection_profile: input.connectionProfile ? (input.connectionProfile as Record<string, unknown>) : null,
          expires_at: expiresAt,
          consumed_at: null,
          time_created: now,
          time_updated: now,
        },
        token,
      )
    })

    const resolveInviteLink = Effect.fn("Pair.resolveInviteLink")(function* (input: {
      roomID: string
      actorPeerID: string
      connectionProfile?: ConnectionProfile
      capabilities?: Capability[]
      ttl?: Duration.Input
    }) {
      const invite = yield* issueInvite({
        roomID: input.roomID,
        actorPeerID: input.actorPeerID,
        capabilities: input.capabilities,
        connectionProfile: input.connectionProfile,
        ttl: input.ttl,
      })
      const roomRow = yield* ensureActiveRoom(input.roomID)
      const room = roomFromRow(roomRow)
      const profile = input.connectionProfile ?? {
        method: "direct" as const,
        hostUrl: "",
      }
      return {
        hostUrl: profile.hostUrl,
        roomID: invite.roomID,
        token: invite.token,
        sessionID: room.sessionID,
        expiresAt: invite.expiresAt,
        connectionProfile: profile,
        workspaceID: undefined,
        directory: undefined,
      }
    })

    const join = Effect.fn("Pair.join")(function* (input: { inviteToken: string; name: string }) {
      const now = Date.now()
      const peerID = crypto.randomUUID()
      const result = Database.transaction((db) => {
        const invite = db
          .select()
          .from(PairInviteTable)
          .where(eq(PairInviteTable.token_hash, hashToken(input.inviteToken)))
          .get()
        if (!invite) return { status: "missing" as const }
        if (invite.consumed_at) return { status: "consumed" as const, inviteID: invite.id }
        if (Date.parse(invite.expires_at) <= now) return { status: "expired" as const, inviteID: invite.id }
        const room = db.select().from(PairRoomTable).where(eq(PairRoomTable.id, invite.room_id)).get()
        if (!room || room.status !== "active") return { status: "room_missing" as const, roomID: invite.room_id }
        db.update(PairInviteTable)
          .set({ consumed_at: new Date(now).toISOString(), time_updated: now })
          .where(eq(PairInviteTable.id, invite.id))
          .run()
        db.insert(PairPeerTable)
          .values({
            id: peerID,
            room_id: room.id,
            name: input.name,
            role: "guest",
            status: "connected",
            capabilities: invite.capabilities,
            last_seen_at: new Date(now).toISOString(),
            time_created: now,
            time_updated: now,
          })
          .run()
        return { status: "joined" as const, room, peer: db.select().from(PairPeerTable).where(eq(PairPeerTable.id, peerID)).get() }
      })
      if (result.status === "missing") return yield* new InviteNotFoundError()
      if (result.status === "consumed") return yield* new InviteConsumedError({ inviteID: result.inviteID })
      if (result.status === "expired") return yield* new InviteExpiredError({ inviteID: result.inviteID })
      if (result.status === "room_missing") return yield* new RoomNotFoundError({ roomID: result.roomID })
      if (!result.peer) return yield* new PeerNotFoundError({ roomID: result.room.id, peerID })
      yield* bus.publish(Event.PeerJoined, { roomID: result.room.id, peerID, role: "guest" })
      const room = roomFromRow(result.room)
      const peer = peerFromRow(result.peer)
      const credential = yield* credSvc.issue({
        peerID,
        roomID: room.id,
        sessionID: room.sessionID,
        capabilities: peer.capabilities,
      }).pipe(
        Effect.catchCause(() =>
          Effect.fail(new PairCredentialIssueError({ roomID: room.id, peerID })),
        ),
      )
      return { room, peer, credential }
    })

    const leave = Effect.fn("Pair.leave")(function* (input: { roomID: string; peerID: string; actorPeerID: string }) {
      const room = yield* ensureActiveRoom(input.roomID)
      const actor = yield* ensureConnectedPeer(input.roomID, input.actorPeerID)
      yield* ensurePeer(input.roomID, input.peerID)
      if (input.actorPeerID !== input.peerID) yield* ensureControlAuthority(room, actor)
      Database.use((db) =>
        db
          .update(PairPeerTable)
          .set({ status: "left", last_seen_at: new Date().toISOString(), time_updated: Date.now() })
          .where(and(eq(PairPeerTable.room_id, input.roomID), eq(PairPeerTable.id, input.peerID)))
          .run(),
      )
      yield* bus.publish(Event.PeerLeft, { roomID: input.roomID, peerID: input.peerID })
    })

    const closeRoom = Effect.fn("Pair.closeRoom")(function* (input: { roomID: string; actorPeerID: string }) {
      const room = yield* ensureActiveRoom(input.roomID)
      const actor = yield* ensureConnectedPeer(input.roomID, input.actorPeerID)
      yield* ensureControlAuthority(room, actor)
      Database.use((db) =>
        db
          .update(PairRoomTable)
          .set({ status: "closed", closed_at: new Date().toISOString(), time_updated: Date.now() })
          .where(eq(PairRoomTable.id, input.roomID))
          .run(),
      )
      yield* bus.publish(Event.RoomClosed, { roomID: input.roomID })
    })

    const requestControl = Effect.fn("Pair.requestControl")(function* (input: { roomID: string; peerID: string }) {
      yield* ensureActiveRoom(input.roomID)
      const peer = yield* ensureConnectedPeer(input.roomID, input.peerID)
      if (!peer.capabilities.includes("request_control")) {
        return yield* new UnauthorizedError({ roomID: input.roomID, peerID: input.peerID, capability: "request_control" })
      }
      yield* bus.publish(Event.ControlRequested, input)
    })

    const grantControl = Effect.fn("Pair.grantControl")(function* (input: {
      roomID: string
      peerID: string
      actorPeerID: string
    }) {
      const current = yield* ensureActiveRoom(input.roomID)
      const actor = yield* ensureConnectedPeer(input.roomID, input.actorPeerID)
      yield* ensureConnectedPeer(input.roomID, input.peerID)
      yield* ensureControlAuthority(current, actor)
      Database.use((db) =>
        db
          .update(PairRoomTable)
          .set({ driver_peer_id: input.peerID, time_updated: Date.now() })
          .where(eq(PairRoomTable.id, input.roomID))
          .run(),
      )
      const room = roomFromRow(yield* ensureRoom(input.roomID))
      yield* bus.publish(Event.ControlGranted, { roomID: input.roomID, peerID: input.peerID })
      return room
    })

    const revokeControl = Effect.fn("Pair.revokeControl")(function* (input: {
      roomID: string
      peerID: string
      actorPeerID: string
    }) {
      const room = yield* ensureActiveRoom(input.roomID)
      const actor = yield* ensureConnectedPeer(input.roomID, input.actorPeerID)
      yield* ensureConnectedPeer(input.roomID, input.peerID)
      yield* ensureControlAuthority(room, actor)
      Database.use((db) =>
        db
          .update(PairRoomTable)
          .set({ driver_peer_id: room.host_peer_id, time_updated: Date.now() })
          .where(eq(PairRoomTable.id, input.roomID))
          .run(),
      )
      const updated = roomFromRow(yield* ensureRoom(input.roomID))
      yield* bus.publish(Event.ControlRevoked, { roomID: input.roomID, peerID: input.peerID })
      return updated
    })

    const authorize = Effect.fn("Pair.authorize")(function* (input: {
      roomID: string
      peerID: string
      capability: Capability
    }) {
      const room = getRoomRow(input.roomID)
      if (!room || room.status !== "active") return false
      const peer = getPeerRow(input.roomID, input.peerID)
      return peer?.status === "connected" && peer.capabilities.includes(input.capability)
    })

    return Service.of({
      createRoom,
      getRoom,
      issueInvite,
      resolveInviteLink,
      join,
      leave,
      closeRoom,
      requestControl,
      grantControl,
      revokeControl,
      authorize,
    })
  }).pipe(Effect.withSpan("Pair.layer")),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer), Layer.provide(PairCredential.defaultLayer))
