type PairSessionEventProperties = {
  readonly roomID?: string
  readonly sessionID?: string
  readonly info?: {
    readonly id?: string
    readonly sessionID?: string
  }
}

type PairSessionEvent = {
  readonly type?: string
  readonly properties?: PairSessionEventProperties | undefined
}

function isObject(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object"
}

function hasSessionID(properties: PairSessionEventProperties, sessionID: string) {
  return properties.sessionID === sessionID || properties.info?.id === sessionID || properties.info?.sessionID === sessionID
}

export function isPairSessionEvent(event: unknown, input: { readonly roomID: string; readonly sessionID: string }) {
  if (!isObject(event)) return false
  if (typeof event.type !== "string") return false
  if (!isObject(event.properties)) return false
  if (event.type.startsWith("pair.")) return event.properties.roomID === input.roomID
  return hasSessionID(event.properties as PairSessionEventProperties, input.sessionID)
}
