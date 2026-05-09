import { describe, expect } from "bun:test"
import { Duration, Effect, Layer } from "effect"
import { WorkspaceID } from "../../src/control-plane/schema"
import type { Pair } from "../../src/pair/pair"
import { PairTicket } from "../../src/pair/ticket"
import { testEffect } from "../lib/effect"

const it = testEffect(PairTicket.layer)
const itExpiring = testEffect(Layer.effect(PairTicket.Service, PairTicket.make(Duration.millis(5))))

const caps = ["view_session", "request_control"] satisfies Pair.Capability[]

describe("pair signaling tickets", () => {
  it.live("consumes tickets once", () =>
    Effect.gen(function* () {
      const tickets = yield* PairTicket.Service
      const scope = {
        roomID: "room-1",
        sessionID: "session-1",
        peerID: "peer-1",
        directory: "/tmp/a",
        capabilities: caps,
      }
      const issued = yield* tickets.issue(scope)

      expect(yield* tickets.consume({ ...scope, ticket: issued.ticket })).toBe(true)
      expect(yield* tickets.consume({ ...scope, ticket: issued.ticket })).toBe(false)
    }),
  )

  it.live("rejects tickets scoped to a different peer", () =>
    Effect.gen(function* () {
      const tickets = yield* PairTicket.Service
      const scope = { roomID: "room-1", sessionID: "session-1", peerID: "peer-1", capabilities: caps }
      const issued = yield* tickets.issue(scope)

      expect(yield* tickets.consume({ ...scope, peerID: "peer-2", ticket: issued.ticket })).toBe(false)
      expect(yield* tickets.consume({ ...scope, ticket: issued.ticket })).toBe(true)
    }),
  )

  it.live("rejects tickets scoped to a different workspace", () =>
    Effect.gen(function* () {
      const tickets = yield* PairTicket.Service
      const workspaceID = WorkspaceID.ascending()
      const scope = { roomID: "room-1", sessionID: "session-1", peerID: "peer-1", workspaceID, capabilities: caps }
      const issued = yield* tickets.issue(scope)

      expect(
        yield* tickets.consume({ ...scope, workspaceID: WorkspaceID.ascending(), ticket: issued.ticket }),
      ).toBe(false)
      expect(yield* tickets.consume({ ...scope, ticket: issued.ticket })).toBe(true)
    }),
  )

  itExpiring.live("rejects tickets after the TTL elapses", () =>
    Effect.gen(function* () {
      const tickets = yield* PairTicket.Service
      const scope = { roomID: "room-1", sessionID: "session-1", peerID: "peer-1", capabilities: caps }
      const issued = yield* tickets.issue(scope)

      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)))

      expect(yield* tickets.consume({ ...scope, ticket: issued.ticket })).toBe(false)
    }),
  )
})
