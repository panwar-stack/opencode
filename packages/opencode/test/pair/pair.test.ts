import { afterEach, describe, expect } from "bun:test"
import { Bus } from "@/bus"
import { Pair } from "@/pair/pair"
import { ProjectID } from "@/project/schema"
import { ProjectTable } from "@/project/project.sql"
import { SessionID } from "@/session/schema"
import { SessionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { resetDatabase } from "../fixture/db"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await resetDatabase()
})

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, Pair.defaultLayer))

const seedSession = () =>
  Database.use((db) => {
    const now = Date.now()
    const sessionID = SessionID.descending()
    db.insert(ProjectTable)
      .values({
        id: ProjectID.global,
        worktree: "/tmp/opencode-pair-test",
        vcs: null,
        name: "Pair Test",
        icon_url: null,
        icon_url_override: null,
        icon_color: null,
        time_created: now,
        time_updated: now,
        time_initialized: null,
        sandboxes: [],
        commands: null,
      })
      .onConflictDoNothing()
      .run()
    db.insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectID.global,
        workspace_id: null,
        parent_id: null,
        slug: "pair-test",
        directory: "/tmp/opencode-pair-test",
        path: null,
        title: "Pair Test",
        version: "test",
        share_url: null,
        summary_additions: null,
        summary_deletions: null,
        summary_files: null,
        summary_diffs: null,
        revert: null,
        permission: null,
        agent: null,
        model: null,
        time_created: now,
        time_updated: now,
        time_compacting: null,
        time_archived: null,
      })
      .run()
    return sessionID
  })

describe("pair service", () => {
  it.live("creates a room with a connected host driver", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const pair = yield* Pair.Service
        const room = yield* pair.createRoom({ sessionID: seedSession(), hostName: "Host" })

        expect(room.status).toBe("active")
        expect(room.driverPeerID).toBe(room.hostPeerID)
        expect(yield* pair.authorize({ roomID: room.id, peerID: room.hostPeerID, capability: "control_driver" })).toBe(true)
      }),
    ),
  )

  it.live("issues single-use invites and joins guests", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const pair = yield* Pair.Service
        const room = yield* pair.createRoom({ sessionID: seedSession() })
        const invite = yield* pair.issueInvite({ roomID: room.id, actorPeerID: room.hostPeerID })
        const joined = yield* pair.join({ inviteToken: invite.token, name: "Guest" })

        expect(joined.room.id).toBe(room.id)
        expect(joined.peer.role).toBe("guest")
        expect(yield* pair.authorize({ roomID: room.id, peerID: joined.peer.id, capability: "request_control" })).toBe(true)
        expect(yield* Effect.exit(pair.join({ inviteToken: invite.token, name: "Other" }))).toMatchObject({ _tag: "Failure" })
      }),
    ),
  )

  it.live("grants and revokes driver control", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const pair = yield* Pair.Service
        const room = yield* pair.createRoom({ sessionID: seedSession() })
        const invite = yield* pair.issueInvite({ roomID: room.id, actorPeerID: room.hostPeerID })
        const joined = yield* pair.join({ inviteToken: invite.token, name: "Guest" })

        expect((yield* pair.grantControl({ roomID: room.id, peerID: joined.peer.id, actorPeerID: room.hostPeerID })).driverPeerID).toBe(
          joined.peer.id,
        )
        expect((yield* pair.revokeControl({ roomID: room.id, peerID: joined.peer.id, actorPeerID: room.hostPeerID })).driverPeerID).toBe(
          room.hostPeerID,
        )
      }),
    ),
  )

  it.live("requires host or control driver authority for privileged actions", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const pair = yield* Pair.Service
        const room = yield* pair.createRoom({ sessionID: seedSession() })
        const invite = yield* pair.issueInvite({ roomID: room.id, actorPeerID: room.hostPeerID })
        const joined = yield* pair.join({ inviteToken: invite.token, name: "Guest" })

        expect(yield* Effect.exit(pair.issueInvite({ roomID: room.id, actorPeerID: joined.peer.id }))).toMatchObject({ _tag: "Failure" })
        expect(yield* Effect.exit(pair.closeRoom({ roomID: room.id, actorPeerID: joined.peer.id }))).toMatchObject({ _tag: "Failure" })
        expect(yield* Effect.exit(pair.grantControl({ roomID: room.id, peerID: room.hostPeerID, actorPeerID: joined.peer.id }))).toMatchObject({
          _tag: "Failure",
        })

        yield* pair.grantControl({ roomID: room.id, peerID: joined.peer.id, actorPeerID: room.hostPeerID })
        yield* pair.revokeControl({ roomID: room.id, peerID: joined.peer.id, actorPeerID: joined.peer.id })
        const updated = yield* pair.getRoom(room.id)
        expect(updated._tag === "Some" ? updated.value.driverPeerID : undefined).toBe(room.hostPeerID)
      }),
    ),
  )

  it.live("restricts invites to safe guest and issuer capabilities", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const pair = yield* Pair.Service
        const room = yield* pair.createRoom({ sessionID: seedSession() })

        expect(
          yield* Effect.exit(
            pair.issueInvite({ roomID: room.id, actorPeerID: room.hostPeerID, capabilities: ["view_session", "run_shell"] }),
          ),
        ).toMatchObject({ _tag: "Failure" })

        const limited = yield* pair.createRoom({ sessionID: seedSession(), capabilities: ["view_session", "control_driver"] })
        expect(
          yield* Effect.exit(
            pair.issueInvite({ roomID: limited.id, actorPeerID: limited.hostPeerID, capabilities: ["view_session", "view_files"] }),
          ),
        ).toMatchObject({ _tag: "Failure" })
      }),
    ),
  )

  it.live("marks peers left and rooms closed", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const pair = yield* Pair.Service
        const room = yield* pair.createRoom({ sessionID: seedSession() })
        const invite = yield* pair.issueInvite({ roomID: room.id, actorPeerID: room.hostPeerID })
        const joined = yield* pair.join({ inviteToken: invite.token, name: "Guest" })

        yield* pair.leave({ roomID: room.id, peerID: joined.peer.id, actorPeerID: room.hostPeerID })
        expect(yield* pair.authorize({ roomID: room.id, peerID: joined.peer.id, capability: "view_session" })).toBe(false)

        const secondInvite = yield* pair.issueInvite({ roomID: room.id, actorPeerID: room.hostPeerID })
        const secondJoined = yield* pair.join({ inviteToken: secondInvite.token, name: "Second Guest" })
        yield* pair.leave({ roomID: room.id, peerID: secondJoined.peer.id, actorPeerID: secondJoined.peer.id })
        expect(yield* Effect.exit(pair.requestControl({ roomID: room.id, peerID: secondJoined.peer.id }))).toMatchObject({ _tag: "Failure" })

        yield* pair.closeRoom({ roomID: room.id, actorPeerID: room.hostPeerID })
        const closed = yield* pair.getRoom(room.id)
        expect(closed._tag).toBe("Some")
        if (closed._tag === "Some") expect(closed.value.status).toBe("closed")
        expect(yield* pair.authorize({ roomID: room.id, peerID: room.hostPeerID, capability: "control_driver" })).toBe(false)
      }),
    ),
  )
})
