import { Option, Schema } from "effect"

export const ConnectionMethod = Schema.Literals(["direct", "private_network", "ssh_tunnel", "relay", "manual"])
export type ConnectionMethod = Schema.Schema.Type<typeof ConnectionMethod>

export const ConnectionProfile = Schema.Struct({
  method: ConnectionMethod,
  hostUrl: Schema.String,
  vpnHost: Schema.optional(Schema.String),
  tunnelCommand: Schema.optional(Schema.String),
  relayId: Schema.optional(Schema.String),
  attachCommand: Schema.optional(Schema.String),
})
export type ConnectionProfile = Schema.Schema.Type<typeof ConnectionProfile>

export const InviteLink = Schema.Struct({
  hostUrl: Schema.String,
  roomID: Schema.String,
  token: Schema.String,
  sessionID: Schema.String,
  expiresAt: Schema.String,
  connectionProfile: ConnectionProfile,
  workspaceID: Schema.optional(Schema.String),
  directory: Schema.optional(Schema.String),
})
export type InviteLink = Schema.Schema.Type<typeof InviteLink>

const PRIVATE_IP_RANGES = [
  [/^10\./, /^10\./],
  [/^172\.(1[6-9]|2\d|3[01])\./, /^172\.(1[6-9]|2\d|3[01])\./],
  [/^192\.168\./, /^192\.168\./],
] as const

const LOCALHOST_PATTERNS = [/^localhost$/i, /^127\.0\.0\.1$/, /^\[::1\]$/] as const

export function detectHostReachability(hostname: string): ConnectionMethod {
  if (LOCALHOST_PATTERNS.some((re) => re.test(hostname))) return "manual"
  if (PRIVATE_IP_RANGES.some(([re]) => re.test(hostname))) return "private_network"
  return "direct"
}

export function isNonPublicHost(hostname: string): boolean {
  if (LOCALHOST_PATTERNS.some((re) => re.test(hostname))) return true
  return PRIVATE_IP_RANGES.some(([re]) => re.test(hostname))
}

const INVITE_LINK_PREFIX = "opencode://pair-join?"

export function formatInviteLink(link: InviteLink): string {
  const params = new URLSearchParams()
  params.set("hostUrl", link.hostUrl)
  params.set("roomID", link.roomID)
  params.set("token", link.token)
  params.set("sessionID", link.sessionID)
  params.set("expiresAt", link.expiresAt)
  params.set("connectionProfile", encodeURIComponent(JSON.stringify(link.connectionProfile)))
  if (link.workspaceID) params.set("workspaceID", link.workspaceID)
  if (link.directory) params.set("directory", link.directory)
  return INVITE_LINK_PREFIX + params.toString()
}

export function parseInviteLink(input: string): InviteLink | null {
  if (!input.startsWith(INVITE_LINK_PREFIX)) return null
  const queryString = input.slice(INVITE_LINK_PREFIX.length)
  const params = new URLSearchParams(queryString)
  const hostUrl = params.get("hostUrl")
  const roomID = params.get("roomID")
  const token = params.get("token")
  const sessionID = params.get("sessionID")
  const expiresAt = params.get("expiresAt")
  const connectionProfileRaw = params.get("connectionProfile")
  if (!hostUrl || !roomID || !token || !sessionID || !expiresAt || !connectionProfileRaw) return null
  const connectionProfile = Schema.decodeUnknownOption(ConnectionProfile)(JSON.parse(decodeURIComponent(connectionProfileRaw)))
  if (Option.isNone(connectionProfile)) return null
  return {
    hostUrl,
    roomID,
    token,
    sessionID,
    expiresAt,
    connectionProfile: connectionProfile.value,
    workspaceID: params.get("workspaceID") ?? undefined,
    directory: params.get("directory") ?? undefined,
  }
}
