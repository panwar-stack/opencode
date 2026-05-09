import { Bus } from "@/bus"
import { Pair } from "@/pair/pair"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { NotFoundError } from "@/storage/storage"
import { Effect, Option } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { InstanceHttpApi } from "../api"
import { ApiNotFoundError } from "../errors"
import { PairSessionMessagesQuery, PairSessionPartsQuery } from "../groups/pair-session"
import { isPairSessionEvent } from "@/server/shared/pair-session-event"

const ROOM_ID_PATTERN = /^\/pair\/rooms\/([^/]+)\/session/

function extractRoomID(request: HttpServerRequest.HttpServerRequest): string {
  const url = new URL(request.url, "http://localhost")
  const match = url.pathname.match(ROOM_ID_PATTERN)
  return match ? match[1] : ""
}

function mapNotFound(error: { message: string }) {
  return new ApiNotFoundError({ name: "NotFoundError", data: { message: error.message } })
}

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function eventResponse(bus: Bus.Interface, roomID: string, sessionID: string) {
  const events = bus.subscribeAll().pipe(
    Stream.takeUntil((event) => event.type === Bus.InstanceDisposed.type),
    Stream.filter((event) => isPairSessionEvent(event, { roomID, sessionID })),
  )
  const heartbeat = Stream.tick("10 seconds").pipe(
    Stream.drop(1),
    Stream.map(() => ({ id: Bus.createID(), type: "server.heartbeat", properties: {} })),
  )

  return HttpServerResponse.stream(
    Stream.make({ id: Bus.createID(), type: "server.connected", properties: {} }).pipe(
      Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
      Stream.map(eventData),
      Stream.pipeThroughChannel(Sse.encode()),
      Stream.encodeText,
      Stream.ensuring(Effect.sync(() => undefined)),
    ),
    {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

export const pairSessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "pair-session", (handlers) =>
  Effect.gen(function* () {
    const pair = yield* Pair.Service
    const bus = yield* Bus.Service
    const session = yield* Session.Service
    const todo = yield* Todo.Service

    return handlers
      .handle(
        "sessionInfo",
        Effect.fn("PairSessionHttpApi.sessionInfo")(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const roomID = extractRoomID(request)
          const room = yield* pair.getRoom(roomID)
          if (Option.isNone(room)) return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: "Pair room not found" } })
          return yield* session.get(room.value.sessionID).pipe(
            Effect.mapError(mapNotFound),
          )
        }),
      )
      .handle(
        "sessionMessages",
        Effect.fn("PairSessionHttpApi.sessionMessages")(function* (ctx: {
          query: typeof PairSessionMessagesQuery.Type
        }) {
          const request = yield* HttpServerRequest.HttpServerRequest
          const roomID = extractRoomID(request)
          const room = yield* pair.getRoom(roomID)
          if (Option.isNone(room)) return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: "Pair room not found" } })
          return yield* session.messages({
            sessionID: room.value.sessionID,
            limit: ctx.query.limit,
          }).pipe(Effect.mapError(mapNotFound))
        }),
      )
      .handle(
        "sessionParts",
        Effect.fn("PairSessionHttpApi.sessionParts")(function* (ctx: {
          query: typeof PairSessionPartsQuery.Type
        }) {
          const request = yield* HttpServerRequest.HttpServerRequest
          const roomID = extractRoomID(request)
          const room = yield* pair.getRoom(roomID)
          if (Option.isNone(room)) return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: "Pair room not found" } })
          const msg = yield* session.findMessage(room.value.sessionID, (m) => m.info.id === ctx.query.messageID).pipe(
            Effect.mapError(mapNotFound),
          )
          if (Option.isNone(msg)) return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: "Message not found" } })
          return msg.value.parts
        }),
      )
      .handle(
        "sessionTodos",
        Effect.fn("PairSessionHttpApi.sessionTodos")(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const roomID = extractRoomID(request)
          const room = yield* pair.getRoom(roomID)
          if (Option.isNone(room)) return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: "Pair room not found" } })
          return yield* todo.get(room.value.sessionID).pipe(
            Effect.mapError(mapNotFound),
          )
        }),
      )
      .handle(
        "sessionDiff",
        Effect.fn("PairSessionHttpApi.sessionDiff")(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const roomID = extractRoomID(request)
          const room = yield* pair.getRoom(roomID)
          if (Option.isNone(room)) return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: "Pair room not found" } })
          return yield* session.diff(room.value.sessionID)
        }),
      )
      .handle(
        "sessionEvent",
        Effect.fn("PairSessionHttpApi.sessionEvent")(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const roomID = extractRoomID(request)
          const room = yield* pair.getRoom(roomID)
          if (Option.isNone(room)) return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: "Pair room not found" } })
          return eventResponse(bus, roomID, room.value.sessionID)
        }),
      )
  }),
)
