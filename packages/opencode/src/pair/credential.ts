export * as PairCredential from "./credential"

import { WorkspaceID } from "@/control-plane/schema"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { Cache, Clock, Context, Duration, Effect, Layer, Option, Schema } from "effect"
import { randomBytes } from "crypto"

export const Credential = Schema.Struct({
  peerID: Schema.String,
  roomID: Schema.String,
  sessionID: Schema.String,
  capabilities: Schema.mutable(Schema.Array(Schema.String)),
  token: Schema.String,
  expiresAt: Schema.Number,
})
export type Credential = Schema.Schema.Type<typeof Credential>

const DEFAULT_TTL = Duration.hours(24)
const CAPACITY = 10_000

export interface Interface {
  issue(input: {
    peerID: string
    roomID: string
    sessionID: string
    capabilities: readonly string[]
    directory?: string
    workspaceID?: WorkspaceID
  }): Effect.Effect<Credential>
  validate(token: string): Effect.Effect<Option.Option<Credential>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PairCredential") {}

export const make = (ttl: Duration.Input = DEFAULT_TTL) =>
  Effect.gen(function* () {
    const cache = yield* Cache.make<string, Credential>({
      capacity: CAPACITY,
      timeToLive: ttl,
      lookup: () => Effect.die("PairCredential cache lookup should never be called"),
    })

    const tokenTTL = Duration.toMillis(Duration.fromInputUnsafe(ttl))

    return Service.of({
      issue: Effect.fn("PairCredential.issue")(function* (input) {
        const token = randomBytes(48).toString("base64url")
        const expiresAt = Date.now() + tokenTTL
        const credential: Credential = {
          peerID: input.peerID,
          roomID: input.roomID,
          sessionID: input.sessionID,
          capabilities: [...input.capabilities],
          token,
          expiresAt,
        }
        yield* Cache.set(cache, token, credential)
        return credential
      }),
      validate: Effect.fn("PairCredential.validate")(function* (token) {
        return yield* Cache.get(cache, token).pipe(
          Effect.asSome,
          Effect.catchCause(() => Effect.succeed(Option.none())),
        )
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
