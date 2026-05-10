import { describe, expect, test } from "bun:test"
import { isPairSessionEvent } from "../../src/server/shared/pair-session-event"

describe("pair session event filter", () => {
  const input = { roomID: "room-1", sessionID: "session-1" }

  const cases = [
    {
      name: "rejects non-object inputs",
      event: null,
      expected: false,
    },
    {
      name: "rejects objects without a string type",
      event: { type: 123, properties: { roomID: "room-1" } },
      expected: false,
    },
    {
      name: "rejects objects without properties",
      event: { type: "pair.peer.joined" },
      expected: false,
    },
    {
      name: "matches pair events by room",
      event: { type: "pair.peer.joined", properties: { roomID: "room-1" } },
      expected: true,
    },
    {
      name: "rejects pair events for another room",
      event: { type: "pair.peer.joined", properties: { roomID: "room-2" } },
      expected: false,
    },
    {
      name: "matches session events by sessionID",
      event: { type: "session.updated", properties: { sessionID: "session-1" } },
      expected: true,
    },
    {
      name: "matches session events by nested info.id",
      event: { type: "session.updated", properties: { info: { id: "session-1" } } },
      expected: true,
    },
    {
      name: "matches session events by nested info.sessionID",
      event: { type: "session.updated", properties: { info: { sessionID: "session-1" } } },
      expected: true,
    },
    {
      name: "rejects session events for another session",
      event: { type: "session.updated", properties: { info: { sessionID: "session-2" } } },
      expected: false,
    },
  ] as const

  for (const item of cases) {
    test(item.name, () => {
      expect(isPairSessionEvent(item.event, input)).toBe(item.expected)
    })
  }
})
