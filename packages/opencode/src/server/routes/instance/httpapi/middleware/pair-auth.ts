import { PairCredential } from "@/pair/credential"
import { Context, Effect, Layer, Option } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware, HttpApiError } from "effect/unstable/httpapi"
import { PAIR_CREDENTIAL_QUERY } from "@/server/shared/pair-ticket"

export interface PairAuthContext {
  readonly peerID: string
  readonly roomID: string
  readonly sessionID: string
  readonly capabilities: readonly string[]
}

const emptyAuthContext: PairAuthContext = {
  peerID: "",
  roomID: "",
  sessionID: "",
  capabilities: [],
}

export const PairAuthContext = Context.Reference<PairAuthContext>("~opencode/PairAuthContext", {
  defaultValue: () => emptyAuthContext,
})

export class PairAuthMiddleware extends HttpApiMiddleware.Service<PairAuthMiddleware>()(
  "@opencode/PairAuthMiddleware",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

const ROOM_ID_PATTERN = /^\/pair\/rooms\/([^/]+)\/session/

function extractRoomID(request: HttpServerRequest.HttpServerRequest): string | null {
  const url = new URL(request.url, "http://localhost")
  const match = url.pathname.match(ROOM_ID_PATTERN)
  return match ? match[1] : null
}

function extractToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const auth = request.headers.authorization
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth)
    if (match) return match[1]
  }
  const url = new URL(request.url, "http://localhost")
  return url.searchParams.get(PAIR_CREDENTIAL_QUERY)
}

export const pairAuthLayer = Layer.effect(
  PairAuthMiddleware,
  Effect.gen(function* () {
    const credentials = yield* PairCredential.Service

    return PairAuthMiddleware.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const token = extractToken(request)
        if (!token) return yield* new HttpApiError.Unauthorized({})

        const credential = yield* credentials.validate(token)
        if (Option.isNone(credential)) return yield* new HttpApiError.Unauthorized({})

        const urlRoomID = extractRoomID(request)
        if (!urlRoomID || credential.value.roomID !== urlRoomID) return yield* new HttpApiError.Unauthorized({})

        return yield* effect.pipe(
          Effect.provideService(PairAuthContext, credential.value),
        )
      }),
    )
  }),
)
