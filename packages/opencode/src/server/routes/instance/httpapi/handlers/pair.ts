import { Bus } from "@/bus"
import { Pair } from "@/pair/pair"
import { PairTicket } from "@/pair/ticket"
import { PAIR_SIGNALING_TICKET_QUERY, PAIR_SIGNALING_TOKEN_HEADER, PAIR_SIGNALING_TOKEN_HEADER_VALUE } from "@/server/shared/pair-ticket"
import { CorsConfig, isAllowedRequestOrigin, type CorsOptions } from "@/server/cors"
import { Effect, Option } from "effect"
import * as Stream from "effect/Stream"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { InstanceHttpApi } from "../api"
import * as ApiError from "../errors"
import { RoomParams, SignalingQuery, PairPaths } from "../groups/pair"

type PairEventProperties = { readonly roomID?: string }
type PairSocket = {
  readonly peerID: string
  readonly write: (message: string) => Effect.Effect<void>
}

function validOrigin(request: HttpServerRequest.HttpServerRequest, opts: CorsOptions | undefined) {
  return isAllowedRequestOrigin(request.headers.origin, request.headers.host, opts)
}

function mapError(error: Pair.RoomNotFoundError | Pair.PeerNotFoundError | Pair.UnauthorizedError) {
  if (error._tag === "Pair.UnauthorizedError") return new HttpApiError.Forbidden({})
  return ApiError.notFound(error._tag === "Pair.RoomNotFoundError" ? "Pair room not found" : "Pair peer not found")
}

function mapJoinError(
  error: unknown,
) {
  if (error instanceof Pair.InviteNotFoundError) return ApiError.notFound("Pair invite not found")
  if (error instanceof Pair.InviteExpiredError) return ApiError.notFound("Pair invite expired")
  if (error instanceof Pair.InviteConsumedError) return ApiError.notFound("Pair invite consumed")
  if (error instanceof Pair.RoomNotFoundError) return ApiError.notFound("Pair room not found")
  if (error instanceof Pair.PeerNotFoundError) return ApiError.notFound("Pair peer not found")
  if (error instanceof Pair.PairCredentialIssueError) return new HttpApiError.BadRequest({})
  return new HttpApiError.BadRequest({})
}

function pairEventProperties(input: unknown): PairEventProperties {
  return input && typeof input === "object" ? input : {}
}

const signalingSockets = new Map<string, Set<PairSocket>>()

export const pairHandlers = HttpApiBuilder.group(InstanceHttpApi, "pair", (handlers) =>
  Effect.gen(function* () {
    const pair = yield* Pair.Service
    const tickets = yield* PairTicket.Service
    const cors = yield* CorsConfig

    return handlers
      .handle(
        "createRoom",
        Effect.fn("PairHttpApi.createRoom")(function* (ctx: { payload: typeof import("../groups/pair").CreateRoomPayload.Type }) {
          return yield* pair.createRoom({
            sessionID: ctx.payload.sessionID,
            hostName: ctx.payload.hostName,
            capabilities: ctx.payload.capabilities ? [...ctx.payload.capabilities] : undefined,
          })
        }),
      )
      .handle(
        "getRoom",
        Effect.fn("PairHttpApi.getRoom")(function* (ctx: { params: { roomID: string } }) {
          const room = yield* pair.getRoom(ctx.params.roomID)
          if (Option.isNone(room)) return yield* ApiError.notFound("Pair room not found")
          return room.value
        }),
      )
      .handle(
        "closeRoom",
        Effect.fn("PairHttpApi.closeRoom")(function* (ctx: { params: { roomID: string }; payload: { actorPeerID: string } }) {
          yield* pair.closeRoom({ roomID: ctx.params.roomID, actorPeerID: ctx.payload.actorPeerID }).pipe(Effect.catch((error) => Effect.fail(mapError(error))))
          return true
        }),
      )
      .handle(
        "issueInvite",
        Effect.fn("PairHttpApi.issueInvite")(function* (ctx: {
          params: { roomID: string }
          payload: typeof import("../groups/pair").IssueInvitePayload.Type
        }) {
          return yield* pair
            .issueInvite({
              roomID: ctx.params.roomID,
              actorPeerID: ctx.payload.actorPeerID,
              capabilities: ctx.payload.capabilities ? [...ctx.payload.capabilities] : undefined,
              connectionProfile: ctx.payload.connectionProfile,
            })
            .pipe(Effect.catch((error) => Effect.fail(mapError(error))))
        }),
      )
      .handle(
        "resolveInviteLink",
        Effect.fn("PairHttpApi.resolveInviteLink")(function* (ctx: {
          params: { roomID: string }
          payload: typeof import("../groups/pair").IssueInvitePayload.Type
        }) {
          return yield* pair
            .resolveInviteLink({
              roomID: ctx.params.roomID,
              actorPeerID: ctx.payload.actorPeerID,
              capabilities: ctx.payload.capabilities ? [...ctx.payload.capabilities] : undefined,
              connectionProfile: ctx.payload.connectionProfile,
            })
            .pipe(Effect.catch((error) => Effect.fail(mapError(error))))
        }),
      )
      .handle(
        "join",
        Effect.fn("PairHttpApi.join")(function* (ctx: { payload: typeof import("../groups/pair").JoinPayload.Type }) {
          return yield* pair.join(ctx.payload).pipe(Effect.catch((error) => Effect.fail(mapJoinError(error))))
        }),
      )
      .handle(
        "leave",
        Effect.fn("PairHttpApi.leave")(function* (ctx: { params: { roomID: string }; payload: { peerID: string; actorPeerID: string } }) {
          yield* pair
            .leave({ roomID: ctx.params.roomID, peerID: ctx.payload.peerID, actorPeerID: ctx.payload.actorPeerID })
            .pipe(Effect.catch((error) => Effect.fail(mapError(error))))
          return true
        }),
      )
      .handle(
        "requestControl",
        Effect.fn("PairHttpApi.requestControl")(function* (ctx: { params: { roomID: string }; payload: { peerID: string } }) {
          yield* pair.requestControl({ roomID: ctx.params.roomID, peerID: ctx.payload.peerID }).pipe(Effect.catch((error) => Effect.fail(mapError(error))))
          return true
        }),
      )
      .handle(
        "grantControl",
        Effect.fn("PairHttpApi.grantControl")(function* (ctx: { params: { roomID: string }; payload: { peerID: string; actorPeerID: string } }) {
          return yield* pair
            .grantControl({ roomID: ctx.params.roomID, peerID: ctx.payload.peerID, actorPeerID: ctx.payload.actorPeerID })
            .pipe(Effect.catch((error) => Effect.fail(mapError(error))))
        }),
      )
      .handle(
        "revokeControl",
        Effect.fn("PairHttpApi.revokeControl")(function* (ctx: { params: { roomID: string }; payload: { peerID: string; actorPeerID: string } }) {
          return yield* pair
            .revokeControl({ roomID: ctx.params.roomID, peerID: ctx.payload.peerID, actorPeerID: ctx.payload.actorPeerID })
            .pipe(Effect.catch((error) => Effect.fail(mapError(error))))
        }),
      )
      .handle(
        "signalingToken",
        Effect.fn("PairHttpApi.signalingToken")(function* (ctx: { params: { roomID: string }; query: { peerID: string } }) {
          const request = yield* HttpServerRequest.HttpServerRequest
          if (request.headers[PAIR_SIGNALING_TOKEN_HEADER] !== PAIR_SIGNALING_TOKEN_HEADER_VALUE || !validOrigin(request, cors)) {
            return yield* new HttpApiError.Forbidden({})
          }
          const room = yield* pair.getRoom(ctx.params.roomID)
          if (Option.isNone(room)) return yield* ApiError.notFound("Pair room not found")
          if (!(yield* pair.authorize({ roomID: ctx.params.roomID, peerID: ctx.query.peerID, capability: "view_session" }))) {
            return yield* new HttpApiError.Forbidden({})
          }
          return yield* tickets.issue({
            roomID: ctx.params.roomID,
            sessionID: room.value.sessionID,
            peerID: ctx.query.peerID,
            capabilities: ["view_session"],
            ...(yield* PairTicket.scope),
          })
        }),
      )
  }),
)

export const pairSignalingRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const pair = yield* Pair.Service
    const tickets = yield* PairTicket.Service
    const cors = yield* CorsConfig

    yield* router.add(
      "GET",
      PairPaths.signaling,
      Effect.gen(function* () {
        const params = yield* HttpRouter.schemaPathParams(RoomParams)
        const query = yield* HttpServerRequest.schemaSearchParams(SignalingQuery)
        const request = yield* HttpServerRequest.HttpServerRequest
        const room = yield* pair.getRoom(params.roomID)
        if (Option.isNone(room)) return HttpServerResponse.empty({ status: 404 })
        const ticket = new URL(request.url, "http://localhost").searchParams.get(PAIR_SIGNALING_TICKET_QUERY)
        if (!ticket || !query.peerID || !validOrigin(request, cors)) return HttpServerResponse.empty({ status: 403 })
        const valid = yield* tickets.consume({
          ticket,
          roomID: params.roomID,
          sessionID: room.value.sessionID,
          peerID: query.peerID,
          capabilities: ["view_session"],
          ...(yield* PairTicket.scope),
        })
        if (!valid || !(yield* pair.authorize({ roomID: params.roomID, peerID: query.peerID, capability: "view_session" }))) {
          return HttpServerResponse.empty({ status: 403 })
        }

        const socket = yield* Effect.orDie(request.upgrade)
        const write = yield* socket.writer
        const relay = {
          peerID: query.peerID,
          write: (message: string) => write(message).pipe(Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void), Effect.catch(() => Effect.void)),
        }
        const roomSockets = signalingSockets.get(params.roomID) ?? new Set<PairSocket>()
        roomSockets.add(relay)
        signalingSockets.set(params.roomID, roomSockets)
        const events = bus.subscribeAll().pipe(
          Stream.filter((event) => pairEventProperties(event.properties).roomID === params.roomID && event.type.startsWith("pair.")),
          Stream.map((event) => JSON.stringify(event)),
          Stream.runForEach((event) => write(event).pipe(Effect.catch(() => Effect.void))),
          Effect.forkIn(yield* Effect.scope),
        )
        yield* events

        yield* socket.runRaw((message) => {
          if (typeof message !== "string") return Effect.void
          return Effect.all(
            [...roomSockets].filter((item) => item !== relay).map((item) => item.write(message)),
            { discard: true },
          )
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              roomSockets.delete(relay)
              if (roomSockets.size === 0) signalingSockets.delete(params.roomID)
            }),
          ),
          Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
          Effect.orDie,
        )
        return HttpServerResponse.empty()
      }),
    )
  }),
)
