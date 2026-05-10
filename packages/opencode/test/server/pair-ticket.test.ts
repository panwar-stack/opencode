import { describe, expect, test } from "bun:test"
import {
  PAIR_CREDENTIAL_QUERY,
  PAIR_SIGNALING_TICKET_QUERY,
  PAIR_SIGNALING_TOKEN_HEADER,
  PAIR_SIGNALING_TOKEN_HEADER_VALUE,
  hasPairCredentialParam,
  hasPairSignalingTicketURL,
  isPairJoinPath,
  isPairSessionPath,
  isPairSignalingPath,
} from "../../src/server/shared/pair-ticket"

describe("pair ticket helpers", () => {
  test("matches pair route pathnames", () => {
    expect(isPairSignalingPath("/pair/rooms/room-1/signaling")).toBe(true)
    expect(isPairSignalingPath("/pair/rooms/room-1/session")).toBe(false)
    expect(isPairSessionPath("/pair/rooms/room-1/session")).toBe(true)
    expect(isPairSessionPath("/pair/rooms/room-1/session/messages")).toBe(true)
    expect(isPairSessionPath("/pair/rooms/room-1/signaling")).toBe(false)
    expect(isPairJoinPath("/pair/join")).toBe(true)
    expect(isPairJoinPath("/pair/rooms/room-1/join")).toBe(false)
  })

  test("matches query credential paths only on the intended endpoints", () => {
    const signaling = new URL(`http://localhost/pair/rooms/room-1/signaling?${PAIR_SIGNALING_TICKET_QUERY}=ticket-1`)
    const session = new URL(`http://localhost/pair/rooms/room-1/session?${PAIR_CREDENTIAL_QUERY}=cred-1`)
    const wrongPath = new URL(`http://localhost/pair/rooms/room-1/signaling?${PAIR_CREDENTIAL_QUERY}=cred-1`)

    expect(PAIR_SIGNALING_TOKEN_HEADER).toBe("x-opencode-ticket")
    expect(PAIR_SIGNALING_TOKEN_HEADER_VALUE).toBe("1")
    expect(hasPairSignalingTicketURL(signaling)).toBe(true)
    expect(hasPairSignalingTicketURL(new URL("http://localhost/pair/rooms/room-1/signaling"))).toBe(false)
    expect(hasPairCredentialParam(session)).toBe(true)
    expect(hasPairCredentialParam(wrongPath)).toBe(false)
  })
})
