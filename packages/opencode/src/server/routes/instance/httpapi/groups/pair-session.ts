import { BusEvent } from "@/bus/bus-event"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { Todo } from "@/session/todo"
import { Snapshot } from "@/snapshot"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { PairAuthMiddleware } from "../middleware/pair-auth"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { ApiNotFoundError } from "../errors"
import { described } from "./metadata"

const root = "/pair/rooms/:roomID/session"

export const PairSessionPaths = {
  info: `${root}`,
  messages: `${root}/messages`,
  parts: `${root}/parts`,
  todos: `${root}/todos`,
  diff: `${root}/diff`,
  event: `${root}/event`,
} as const

const ServerConnected = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("server.connected"),
  properties: Schema.Struct({}),
})

const ServerHeartbeat = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("server.heartbeat"),
  properties: Schema.Struct({}),
})

const PairSessionEvent = Schema.Union([...BusEvent.effectPayloads(), ServerConnected, ServerHeartbeat]).annotate({
  identifier: "PairSessionEvent",
})

export const PairSessionMessagesQuery = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.String),
})

export const PairSessionPartsQuery = Schema.Struct({
  messageID: Schema.String,
})

const PairSessionRoomParams = {
  roomID: Schema.String,
}

export const PairSessionApi = HttpApi.make("pair-session").add(
  HttpApiGroup.make("pair-session")
    .add(
      HttpApiEndpoint.get("sessionInfo", PairSessionPaths.info, {
        params: PairSessionRoomParams,
        success: described(Session.Info, "Pair session info"),
        error: [ApiNotFoundError, HttpApiError.Forbidden],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.session.info",
          summary: "Get pair session info",
          description: "Get session info for a pair room's session using pair credentials.",
        }),
      ),
      HttpApiEndpoint.get("sessionMessages", PairSessionPaths.messages, {
        params: PairSessionRoomParams,
        query: PairSessionMessagesQuery,
        success: described(Schema.Array(MessageV2.WithParts), "Session messages"),
        error: [ApiNotFoundError, HttpApiError.Forbidden],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.session.messages",
          summary: "Get pair session messages",
          description: "Get messages for a pair room's session using pair credentials.",
        }),
      ),
      HttpApiEndpoint.get("sessionParts", PairSessionPaths.parts, {
        params: PairSessionRoomParams,
        query: PairSessionPartsQuery,
        success: described(Schema.Array(MessageV2.Part), "Session parts"),
        error: [ApiNotFoundError, HttpApiError.Forbidden, HttpApiError.BadRequest],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.session.parts",
          summary: "Get pair session parts",
          description: "Get parts for a specific message in the pair room's session.",
        }),
      ),
      HttpApiEndpoint.get("sessionTodos", PairSessionPaths.todos, {
        params: PairSessionRoomParams,
        success: described(Schema.Array(Todo.Info), "Session todos"),
        error: [ApiNotFoundError, HttpApiError.Forbidden],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.session.todos",
          summary: "Get pair session todos",
          description: "Get todos for the pair room's session.",
        }),
      ),
      HttpApiEndpoint.get("sessionDiff", PairSessionPaths.diff, {
        params: PairSessionRoomParams,
        success: described(Schema.Array(Snapshot.FileDiff), "Session diff"),
        error: [ApiNotFoundError, HttpApiError.Forbidden],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.session.diff",
          summary: "Get pair session diff",
          description: "Get the file changes diff for the pair room's session.",
        }),
      ),
      HttpApiEndpoint.get("sessionEvent", PairSessionPaths.event, {
        params: PairSessionRoomParams,
        success: described(PairSessionEvent, "Pair session event stream"),
        error: [ApiNotFoundError, HttpApiError.Forbidden],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.session.event",
          summary: "Subscribe to pair session events",
          description: "Stream room-scoped pair session events for a remote guest.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "pair-session",
        description: "Scoped pair session bootstrap endpoints for remote guests.",
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(PairAuthMiddleware),
)
