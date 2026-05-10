import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, Option } from "effect"
import { PairCredential } from "@/pair/credential"
import { testEffect } from "../lib/effect"

const it = testEffect(PairCredential.defaultLayer)
const itExpiring = testEffect(Layer.effect(PairCredential.Service, PairCredential.make(Duration.millis(5))))

describe("PairCredential", () => {
  it.live("issue creates credential with correct scope", () =>
    Effect.gen(function* () {
      const svc = yield* PairCredential.Service
      const cred = yield* svc.issue({
        peerID: "peer-1",
        roomID: "room-1",
        sessionID: "ses-1",
        capabilities: ["view_session", "view_files"],
      })

      expect(cred.peerID).toBe("peer-1")
      expect(cred.roomID).toBe("room-1")
      expect(cred.sessionID).toBe("ses-1")
      expect(cred.capabilities).toEqual(["view_session", "view_files"])
      expect(cred.token).toBeTruthy()
      expect(cred.token.length).toBeGreaterThan(32)
      expect(cred.expiresAt).toBeGreaterThan(Date.now())
    }),
  )

  it.live("validate returns credential for valid token", () =>
    Effect.gen(function* () {
      const svc = yield* PairCredential.Service
      const cred = yield* svc.issue({
        peerID: "peer-2",
        roomID: "room-2",
        sessionID: "ses-2",
        capabilities: ["view_session"],
      })

      const validated = yield* svc.validate(cred.token)
      expect(Option.isSome(validated)).toBe(true)
      if (Option.isSome(validated)) {
        expect(validated.value.peerID).toBe("peer-2")
        expect(validated.value.token).toBe(cred.token)
      }
    }),
  )

  it.live("validate returns none for invalid token", () =>
    Effect.gen(function* () {
      const svc = yield* PairCredential.Service
      const validated = yield* svc.validate("nonexistent-token-12345")
      expect(Option.isNone(validated)).toBe(true)
    }),
  )

  it.live("validate returns none for empty token", () =>
    Effect.gen(function* () {
      const svc = yield* PairCredential.Service
      const validated = yield* svc.validate("")
      expect(Option.isNone(validated)).toBe(true)
    }),
  )

  it.live("credentials are scoped to specific room/session", () =>
    Effect.gen(function* () {
      const svc = yield* PairCredential.Service
      const cred1 = yield* svc.issue({
        peerID: "peer-a",
        roomID: "room-a",
        sessionID: "ses-a",
        capabilities: ["view_session"],
      })
      const cred2 = yield* svc.issue({
        peerID: "peer-b",
        roomID: "room-b",
        sessionID: "ses-b",
        capabilities: ["view_files"],
      })

      const v1 = yield* svc.validate(cred1.token)
      const v2 = yield* svc.validate(cred2.token)

      expect(Option.isSome(v1)).toBe(true)
      expect(Option.isSome(v2)).toBe(true)
      if (Option.isSome(v1) && Option.isSome(v2)) {
        expect(v1.value.roomID).toBe("room-a")
        expect(v1.value.sessionID).toBe("ses-a")
        expect(v1.value.capabilities).toEqual(["view_session"])
        expect(v2.value.roomID).toBe("room-b")
        expect(v2.value.sessionID).toBe("ses-b")
        expect(v2.value.capabilities).toEqual(["view_files"])
      }
    }),
  )

  itExpiring.live("returns none after a credential TTL elapses", () =>
    Effect.gen(function* () {
      const svc = yield* PairCredential.Service
      const cred = yield* svc.issue({
        peerID: "peer-exp",
        roomID: "room-exp",
        sessionID: "ses-exp",
        capabilities: ["view_session"],
      })

      yield* Effect.sleep("25 millis")

      const validated = yield* svc.validate(cred.token)
      expect(Option.isNone(validated)).toBe(true)
    }),
  )

  it.live("generated tokens are unique", () =>
    Effect.gen(function* () {
      const svc = yield* PairCredential.Service
      const cred1 = yield* svc.issue({
        peerID: "peer-u1",
        roomID: "room-u",
        sessionID: "ses-u",
        capabilities: ["view_session"],
      })
      const cred2 = yield* svc.issue({
        peerID: "peer-u2",
        roomID: "room-u",
        sessionID: "ses-u",
        capabilities: ["view_session"],
      })

      expect(cred1.token).not.toBe(cred2.token)
    }),
  )
})
