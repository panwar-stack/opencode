import { afterEach, describe, expect, test } from "bun:test"
import { Bus } from "@/bus"
import { Pair } from "@/pair/pair"
import { PairCredential } from "@/pair/credential"
import { ProjectID } from "@/project/schema"
import { ProjectTable } from "@/project/project.sql"
import { SessionID } from "@/session/schema"
import { SessionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Cause, Deferred, Effect, Exit, Layer, Option } from "effect"
import * as Stream from "effect/Stream"
import { resetDatabase } from "../fixture/db"
import { provideInstance, provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await resetDatabase()
})

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, Pair.defaultLayer, PairCredential.defaultLayer))
const failingPairCredentialLayer = Layer.succeed(
  PairCredential.Service,
  PairCredential.Service.of({
    issue: () => Effect.die("credential issuance failed"),
    validate: () => Effect.succeed(Option.none()),
  }),
)
const itCredentialFailure = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    Pair.layer.pipe(Layer.provide(Bus.layer), Layer.provide(failingPairCredentialLayer)),
  ),
)

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

  test("publishes pair bus events for room lifecycle actions", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const busLayer = Bus.layer
    const layer = Layer.mergeAll(
      CrossSpawnSpawner.defaultLayer,
      busLayer,
      Pair.layer.pipe(Layer.provide(busLayer), Layer.provide(PairCredential.defaultLayer)),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const pair = yield* Pair.Service
        const bus = yield* Bus.Service
        const events: string[] = []
        const expected = [
          Pair.Event.RoomCreated.type,
          Pair.Event.PeerJoined.type,
          Pair.Event.PeerJoined.type,
          Pair.Event.ControlRequested.type,
          Pair.Event.ControlGranted.type,
          Pair.Event.ControlRevoked.type,
          Pair.Event.PeerLeft.type,
          Pair.Event.RoomClosed.type,
        ]
        const controlRequested = yield* Deferred.make<void>()
        const eventsDone = yield* Deferred.make<void>()
        let controlRequestedEvent: { roomID: string; peerID: string } | undefined
        let count = 0

        yield* Stream.runForEach(bus.subscribeAll(), (event) =>
          Effect.sync(() => {
            if (!event.type.startsWith("pair.")) return
            events.push(event.type)
            count += 1
            if (count === expected.length) Deferred.doneUnsafe(eventsDone, Effect.void)
          }),
        ).pipe(Effect.forkScoped)

        yield* Stream.runForEach(bus.subscribe(Pair.Event.ControlRequested), (event) =>
          Effect.sync(() => {
            controlRequestedEvent = event.properties
            Deferred.doneUnsafe(controlRequested, Effect.void)
          }),
        ).pipe(Effect.forkScoped)

        yield* Effect.sleep("10 millis")
        const room = yield* pair.createRoom({ sessionID: seedSession() })
        const invite = yield* pair.issueInvite({ roomID: room.id, actorPeerID: room.hostPeerID })
        const joined = yield* pair.join({ inviteToken: invite.token, name: "Guest" })

        yield* pair.requestControl({ roomID: room.id, peerID: joined.peer.id })
        yield* Deferred.await(controlRequested)
        expect(controlRequestedEvent).toEqual({ roomID: room.id, peerID: joined.peer.id })

        yield* pair.grantControl({ roomID: room.id, peerID: joined.peer.id, actorPeerID: room.hostPeerID })
        yield* pair.revokeControl({ roomID: room.id, peerID: joined.peer.id, actorPeerID: room.hostPeerID })
        yield* pair.leave({ roomID: room.id, peerID: joined.peer.id, actorPeerID: joined.peer.id })
        yield* pair.closeRoom({ roomID: room.id, actorPeerID: room.hostPeerID })

        yield* Deferred.await(eventsDone)
        expect(events).toEqual(expected)
      }).pipe(Effect.scoped, provideInstance(tmp.path), Effect.provide(layer)),
    )
  })

  it.live("issueInvite accepts connectionProfile and returns it in response", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const pair = yield* Pair.Service
        const room = yield* pair.createRoom({ sessionID: seedSession() })
        const profile = { method: "private_network" as const, hostUrl: "192.168.1.100:4096" }
        const invite = yield* pair.issueInvite({
          roomID: room.id,
          actorPeerID: room.hostPeerID,
          connectionProfile: profile,
        })
        expect(invite.connectionProfile).toEqual(profile)
      }),
    ),
  )

  it.live("non-public host invite generates manual/private_network connectionProfile", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const pair = yield* Pair.Service
        const room = yield* pair.createRoom({ sessionID: seedSession() })
        const profile = { method: "manual" as const, hostUrl: "localhost:4096" }
        const invite = yield* pair.issueInvite({
          roomID: room.id,
          actorPeerID: room.hostPeerID,
          connectionProfile: profile,
        })
        expect(invite.connectionProfile).not.toBeUndefined()
        expect(invite.connectionProfile!.method).toBe("manual")
        expect(invite.connectionProfile!.hostUrl).toBe("localhost:4096")
      }),
    ),
  )

  it.live("resolveInviteLink returns complete InviteLink with all fields", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const pair = yield* Pair.Service
        const room = yield* pair.createRoom({ sessionID: seedSession() })
        const profile = { method: "direct" as const, hostUrl: "https://opencode.example.com" }
        const link = yield* pair.resolveInviteLink({
          roomID: room.id,
          actorPeerID: room.hostPeerID,
          connectionProfile: profile,
        })
        expect(link.hostUrl).toBe("https://opencode.example.com")
        expect(link.roomID).toBe(room.id)
        expect(link.token).toBeTruthy()
        expect(link.sessionID).toBe(room.sessionID)
        expect(link.expiresAt).toBeTruthy()
        expect(link.connectionProfile.method).toBe("direct")
        expect(link.connectionProfile.hostUrl).toBe("https://opencode.example.com")
      }),
    ),
  )

  it.live("join response includes credential when joining", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const pair = yield* Pair.Service
        const room = yield* pair.createRoom({ sessionID: seedSession() })
        const invite = yield* pair.issueInvite({ roomID: room.id, actorPeerID: room.hostPeerID })
        const joined = yield* pair.join({ inviteToken: invite.token, name: "Guest" })

        expect(joined.credential).not.toBeUndefined()
        expect(joined.credential!.peerID).toBe(joined.peer.id)
        expect(joined.credential!.roomID).toBe(room.id)
        expect(joined.credential!.sessionID).toBe(room.sessionID)
        expect(joined.credential!.token).toBeTruthy()
        expect(joined.credential!.capabilities).toEqual(joined.peer.capabilities)
      }),
    ),
  )

  it.live("join credential can be validated after join", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const pair = yield* Pair.Service
        const credSvc = yield* PairCredential.Service
        const room = yield* pair.createRoom({ sessionID: seedSession() })
        const invite = yield* pair.issueInvite({ roomID: room.id, actorPeerID: room.hostPeerID })
        const joined = yield* pair.join({ inviteToken: invite.token, name: "Guest" })

        expect(joined.credential).not.toBeUndefined()
        const validated = yield* credSvc.validate(joined.credential!.token)
        expect(Option.isSome(validated)).toBe(true)
        if (Option.isSome(validated)) {
          expect(validated.value.peerID).toBe(joined.peer.id)
          expect(validated.value.roomID).toBe(room.id)
        }
      }),
    ),
  )

  itCredentialFailure.live("maps credential issuance failures to PairCredentialIssueError", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const pair = yield* Pair.Service
        const room = yield* pair.createRoom({ sessionID: seedSession() })
        const invite = yield* pair.issueInvite({ roomID: room.id, actorPeerID: room.hostPeerID })
        const exit = yield* Effect.exit(pair.join({ inviteToken: invite.token, name: "Guest" }))

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Pair.PairCredentialIssueError)
      }),
    ),
  )

  it.live("same-server join still works with raw invite token", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const pair = yield* Pair.Service
        const room = yield* pair.createRoom({ sessionID: seedSession() })
        const invite = yield* pair.issueInvite({ roomID: room.id, actorPeerID: room.hostPeerID })
        const joined = yield* pair.join({ inviteToken: invite.token, name: "Guest" })

        expect(joined.room.id).toBe(room.id)
        expect(joined.peer.role).toBe("guest")
        expect(joined.peer.status).toBe("connected")
      }),
    ),
  )
})
