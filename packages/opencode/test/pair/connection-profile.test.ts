import { describe, expect, test } from "bun:test"
import {
  detectHostReachability,
  isNonPublicHost,
  isTailnetHost,
  formatInviteLink,
  parseInviteLink,
  type InviteLink,
} from "@/pair/connection-profile"

describe("connection-profile detectHostReachability", () => {
  test('returns "manual" for localhost', () => {
    expect(detectHostReachability("localhost")).toBe("manual")
  })

  test('returns "manual" for 127.0.0.1', () => {
    expect(detectHostReachability("127.0.0.1")).toBe("manual")
  })

  test('returns "manual" for [::1]', () => {
    expect(detectHostReachability("[::1]")).toBe("manual")
  })

  test('returns "private_network" for 10.0.0.1', () => {
    expect(detectHostReachability("10.0.0.1")).toBe("private_network")
  })

  test('returns "private_network" for 172.16.0.1', () => {
    expect(detectHostReachability("172.16.0.1")).toBe("private_network")
  })

  test('returns "private_network" for 172.31.255.255', () => {
    expect(detectHostReachability("172.31.255.255")).toBe("private_network")
  })

  test('returns "private_network" for 192.168.1.1', () => {
    expect(detectHostReachability("192.168.1.1")).toBe("private_network")
  })

  test('returns "tailnet" for 100.64.0.1', () => {
    expect(detectHostReachability("100.64.0.1")).toBe("tailnet")
  })

  test('returns "tailnet" for 100.127.255.255', () => {
    expect(detectHostReachability("100.127.255.255")).toBe("tailnet")
  })

  test('returns "tailnet" for MagicDNS hostname', () => {
    expect(detectHostReachability("monitoring.yak-bebop.ts.net")).toBe("tailnet")
  })

  test('returns "tailnet" for Tailscale IPv6', () => {
    expect(detectHostReachability("fd7a:115c:a1e0::1")).toBe("tailnet")
  })

  test('returns "direct" for public IP', () => {
    expect(detectHostReachability("93.184.216.34")).toBe("direct")
  })

  test('returns "direct" for domain name', () => {
    expect(detectHostReachability("example.com")).toBe("direct")
  })

  test('returns "direct" for 172.32.0.1 (outside private range)', () => {
    expect(detectHostReachability("172.32.0.1")).toBe("direct")
  })
})

describe("connection-profile isNonPublicHost", () => {
  test("returns true for localhost", () => {
    expect(isNonPublicHost("localhost")).toBe(true)
  })

  test("returns true for 127.0.0.1", () => {
    expect(isNonPublicHost("127.0.0.1")).toBe(true)
  })

  test("returns true for [::1]", () => {
    expect(isNonPublicHost("[::1]")).toBe(true)
  })

  test("returns true for 10.0.0.1", () => {
    expect(isNonPublicHost("10.0.0.1")).toBe(true)
  })

  test("returns true for 192.168.1.1", () => {
    expect(isNonPublicHost("192.168.1.1")).toBe(true)
  })

  test("returns true for 100.64.0.1", () => {
    expect(isNonPublicHost("100.64.0.1")).toBe(true)
  })

  test("returns true for MagicDNS hostname", () => {
    expect(isNonPublicHost("monitoring.yak-bebop.ts.net")).toBe(true)
  })

  test("returns false for public IP", () => {
    expect(isNonPublicHost("93.184.216.34")).toBe(false)
  })

  test("returns false for domain name", () => {
    expect(isNonPublicHost("example.com")).toBe(false)
  })
})

describe("connection-profile isTailnetHost", () => {
  test("returns true for 100.64.0.1", () => {
    expect(isTailnetHost("100.64.0.1")).toBe(true)
  })

  test("returns true for MagicDNS hostname", () => {
    expect(isTailnetHost("monitoring.yak-bebop.ts.net")).toBe(true)
  })

  test("returns true for Tailscale IPv6", () => {
    expect(isTailnetHost("fd7a:115c:a1e0::1")).toBe(true)
  })

  test("returns false for public IP", () => {
    expect(isTailnetHost("93.184.216.34")).toBe(false)
  })
})

describe("connection-profile formatInviteLink / parseInviteLink", () => {
  const invite: InviteLink = {
    hostUrl: "https://opencode.example.com",
    roomID: "room-abc-123",
    token: "invite-token-xyz",
    sessionID: "ses_def_456",
    expiresAt: "2026-12-31T23:59:59.000Z",
    connectionProfile: {
      method: "tailnet",
      hostUrl: "monitoring.yak-bebop.ts.net:4096",
      vpnHost: "vpn.example.com",
    },
    workspaceID: "ws-001",
    directory: "/home/user/project",
  }

  test("produces URL-safe string with all fields", () => {
    const link = formatInviteLink(invite)
    expect(link).toStartWith("opencode://pair-join?")
    expect(link).toContain("hostUrl=")
    expect(link).toContain("roomID=")
    expect(link).toContain("token=")
    expect(link).toContain("sessionID=")
    expect(link).toContain("expiresAt=")
    expect(link).toContain("connectionProfile=")
    expect(link).toContain("workspaceID=")
    expect(link).toContain("directory=")
  })

  test("correctly parses formatted link", () => {
    const link = formatInviteLink(invite)
    const parsed = parseInviteLink(link)
    expect(parsed).not.toBeNull()
    expect(parsed!.hostUrl).toBe(invite.hostUrl)
    expect(parsed!.roomID).toBe(invite.roomID)
    expect(parsed!.token).toBe(invite.token)
    expect(parsed!.sessionID).toBe(invite.sessionID)
    expect(parsed!.expiresAt).toBe(invite.expiresAt)
    expect(parsed!.connectionProfile.method).toBe(invite.connectionProfile.method)
    expect(parsed!.connectionProfile.hostUrl).toBe(invite.connectionProfile.hostUrl)
    expect(parsed!.connectionProfile.vpnHost).toBe(invite.connectionProfile.vpnHost)
    expect(parsed!.workspaceID).toBe(invite.workspaceID)
    expect(parsed!.directory).toBe(invite.directory)
  })

  test("returns null for invalid input", () => {
    expect(parseInviteLink("")).toBeNull()
    expect(parseInviteLink("opencode://pair-join?")).toBeNull()
    expect(parseInviteLink("not-a-link")).toBeNull()
    expect(parseInviteLink("https://example.com")).toBeNull()
  })

  test("round-trip: format → parse → original matches", () => {
    const minimal: InviteLink = {
      hostUrl: "http://localhost:4096",
      roomID: "room-min",
      token: "tok",
      sessionID: "ses",
      expiresAt: "2027-01-01T00:00:00.000Z",
      connectionProfile: {
        method: "direct",
        hostUrl: "localhost:4096",
      },
    }
    const link = formatInviteLink(minimal)
    const parsed = parseInviteLink(link)
    expect(parsed).not.toBeNull()
    expect(parsed!.hostUrl).toBe(minimal.hostUrl)
    expect(parsed!.roomID).toBe(minimal.roomID)
    expect(parsed!.token).toBe(minimal.token)
    expect(parsed!.sessionID).toBe(minimal.sessionID)
    expect(parsed!.expiresAt).toBe(minimal.expiresAt)
    expect(parsed!.connectionProfile.method).toBe(minimal.connectionProfile.method)
    expect(parsed!.connectionProfile.hostUrl).toBe(minimal.connectionProfile.hostUrl)
    expect(parsed!.workspaceID).toBeUndefined()
    expect(parsed!.directory).toBeUndefined()
  })

  test("round-trip preserves special characters in hostUrl", () => {
    const withSpecial: InviteLink = {
      hostUrl: "https://host.example.com:4096/path?query=value",
      roomID: "room-special_chars",
      token: "token+with/special=chars",
      sessionID: "ses_special",
      expiresAt: "2027-06-15T12:00:00.000Z",
      connectionProfile: {
        method: "relay",
        hostUrl: "wss://relay.example.com",
        relayId: "relay-001",
      },
    }
    const link = formatInviteLink(withSpecial)
    const parsed = parseInviteLink(link)
    expect(parsed).not.toBeNull()
    expect(parsed!.hostUrl).toBe(withSpecial.hostUrl)
    expect(parsed!.token).toBe(withSpecial.token)
    expect(parsed!.connectionProfile.relayId).toBe("relay-001")
  })

  test("round-trip preserves tailnet connection profiles", () => {
    const withTailnet: InviteLink = {
      hostUrl: "https://monitoring.yak-bebop.ts.net:4096",
      roomID: "room-tailnet",
      token: "token-tailnet",
      sessionID: "ses_tailnet",
      expiresAt: "2027-06-15T12:00:00.000Z",
      connectionProfile: {
        method: "tailnet",
        hostUrl: "monitoring.yak-bebop.ts.net:4096",
      },
    }
    const link = formatInviteLink(withTailnet)
    const parsed = parseInviteLink(link)
    expect(parsed).not.toBeNull()
    expect(parsed!.hostUrl).toBe(withTailnet.hostUrl)
    expect(parsed!.connectionProfile.method).toBe("tailnet")
    expect(parsed!.connectionProfile.hostUrl).toBe(withTailnet.connectionProfile.hostUrl)
  })
})
