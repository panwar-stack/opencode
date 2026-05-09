export * as PairTicket from "./ticket"

import { WorkspaceID } from "@/control-plane/schema"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { PositiveInt } from "@/util/schema"
import { Cache, Context, Duration, Effect, Layer, Schema } from "effect"

const DEFAULT_TTL = Duration.seconds(60)
const CAPACITY = 10_000

export const ConnectToken = Schema.Struct({
  ticket: Schema.String,
  expires_in: PositiveInt,
})

export type Scope = {
  readonly roomID: string
  readonly sessionID: string
  readonly peerID: string
  readonly directory?: string
  readonly workspaceID?: WorkspaceID
  readonly capabilities: readonly string[]
}

export interface Interface {
  issue(input: Scope): Effect.Effect<typeof ConnectToken.Type>
  consume(input: Scope & { readonly ticket: string }): Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PairTicket") {}

function matches(record: Scope, input: Scope) {
  return (
    record.roomID === input.roomID &&
    record.sessionID === input.sessionID &&
    record.peerID === input.peerID &&
    record.directory === input.directory &&
    record.workspaceID === input.workspaceID &&
    input.capabilities.every((capability) => record.capabilities.includes(capability))
  )
}

const noLookup = () => Effect.die("PairTicket cache must be used via set/invalidateWhen, never get")

export const make = (ttl: Duration.Input = DEFAULT_TTL) =>
  Effect.gen(function* () {
    const cache = yield* Cache.make<string, Scope>({ capacity: CAPACITY, lookup: noLookup, timeToLive: ttl })
    const expiresIn = Math.max(1, Math.round(Duration.toSeconds(Duration.fromInputUnsafe(ttl))))
    return Service.of({
      issue: Effect.fn("PairTicket.issue")(function* (input) {
        const ticket = crypto.randomUUID()
        yield* Cache.set(cache, ticket, input)
        return { ticket, expires_in: expiresIn }
      }),
      consume: Effect.fn("PairTicket.consume")(function* (input) {
        return yield* Cache.invalidateWhen(cache, input.ticket, (stored) => matches(stored, input))
      }),
    })
  })

export const layer = Layer.effect(Service, make())

export const defaultLayer = layer

export const scope = Effect.gen(function* () {
  const instance = yield* InstanceRef
  const workspaceID = yield* WorkspaceRef
  return {
    directory: instance?.directory,
    workspaceID,
  }
})
