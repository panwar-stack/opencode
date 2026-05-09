import { Pair } from "@/pair/pair"
import { PairTicket } from "@/pair/ticket"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { ApiNotFoundError } from "../errors"
import { described } from "./metadata"

const root = "/pair"

export const PairPaths = {
  createRoom: `${root}/rooms`,
  getRoom: `${root}/rooms/:roomID`,
  closeRoom: `${root}/rooms/:roomID`,
  issueInvite: `${root}/rooms/:roomID/invite`,
  join: `${root}/join`,
  leave: `${root}/rooms/:roomID/leave`,
  requestControl: `${root}/rooms/:roomID/control/request`,
  grantControl: `${root}/rooms/:roomID/control/grant`,
  revokeControl: `${root}/rooms/:roomID/control/revoke`,
  signalingToken: `${root}/rooms/:roomID/signaling-token`,
  signaling: `${root}/rooms/:roomID/signaling`,
} as const

export const RoomParams = Schema.Struct({ roomID: Schema.String })
export const SignalingQuery = Schema.Struct({
  ticket: Schema.optional(Schema.String),
  peerID: Schema.optional(Schema.String),
})

export const CreateRoomPayload = Schema.Struct({
  sessionID: SessionID,
  hostName: Schema.optional(Schema.String),
  capabilities: Schema.optional(Schema.mutable(Schema.Array(Pair.Capability))),
})

export const IssueInvitePayload = Schema.Struct({
  actorPeerID: Schema.String,
  capabilities: Schema.optional(Schema.mutable(Schema.Array(Pair.Capability))),
})

export const JoinPayload = Schema.Struct({
  inviteToken: Schema.String,
  name: Schema.String,
})

export const ActorPeerPayload = Schema.Struct({
  actorPeerID: Schema.String,
})

export const LeavePayload = Schema.Struct({
  peerID: Schema.String,
  actorPeerID: Schema.String,
})

export const ControlPeerPayload = Schema.Struct({
  peerID: Schema.String,
  actorPeerID: Schema.String,
})

export const RequestControlPayload = Schema.Struct({
  peerID: Schema.String,
})

export const SignalingTokenQuery = Schema.Struct({
  peerID: Schema.String,
})

export const PairApi = HttpApi.make("pair").add(
  HttpApiGroup.make("pair")
    .add(
      HttpApiEndpoint.post("createRoom", PairPaths.createRoom, {
        payload: CreateRoomPayload,
        success: described(Pair.RoomInfo, "Created pair room"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.room.create",
          summary: "Create pair room",
          description: "Create a real-time pair programming room for a session.",
        }),
      ),
      HttpApiEndpoint.get("getRoom", PairPaths.getRoom, {
        params: { roomID: Schema.String },
        success: described(Pair.RoomInfo, "Pair room"),
        error: ApiNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.room.get",
          summary: "Get pair room",
          description: "Get pair room state.",
        }),
      ),
      HttpApiEndpoint.delete("closeRoom", PairPaths.closeRoom, {
        params: { roomID: Schema.String },
        payload: ActorPeerPayload,
        success: described(Schema.Boolean, "Room closed"),
        error: [HttpApiError.BadRequest, HttpApiError.Forbidden, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.room.close",
          summary: "Close pair room",
          description: "Close an active pair room.",
        }),
      ),
      HttpApiEndpoint.post("issueInvite", PairPaths.issueInvite, {
        params: { roomID: Schema.String },
        payload: IssueInvitePayload,
        success: described(Pair.InviteInfo, "Pair invite"),
        error: [HttpApiError.BadRequest, HttpApiError.Forbidden, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.invite.create",
          summary: "Create pair invite",
          description: "Create a scoped one-time invite for a pair room.",
        }),
      ),
      HttpApiEndpoint.post("join", PairPaths.join, {
        payload: JoinPayload,
        success: described(Pair.JoinInfo, "Joined room"),
        error: [HttpApiError.BadRequest, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.join",
          summary: "Join pair room",
          description: "Join a pair room using an invite token.",
        }),
      ),
      HttpApiEndpoint.post("leave", PairPaths.leave, {
        params: { roomID: Schema.String },
        payload: LeavePayload,
        success: described(Schema.Boolean, "Peer left"),
        error: [HttpApiError.BadRequest, HttpApiError.Forbidden, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.leave",
          summary: "Leave pair room",
          description: "Mark a peer as left.",
        }),
      ),
      HttpApiEndpoint.post("requestControl", PairPaths.requestControl, {
        params: { roomID: Schema.String },
        payload: RequestControlPayload,
        success: described(Schema.Boolean, "Control requested"),
        error: [HttpApiError.Forbidden, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.control.request",
          summary: "Request pair control",
          description: "Request pair programming driver control.",
        }),
      ),
      HttpApiEndpoint.post("grantControl", PairPaths.grantControl, {
        params: { roomID: Schema.String },
        payload: ControlPeerPayload,
        success: described(Pair.RoomInfo, "Updated pair room"),
        error: [HttpApiError.Forbidden, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.control.grant",
          summary: "Grant pair control",
          description: "Grant driver control to a peer.",
        }),
      ),
      HttpApiEndpoint.post("revokeControl", PairPaths.revokeControl, {
        params: { roomID: Schema.String },
        payload: ControlPeerPayload,
        success: described(Pair.RoomInfo, "Updated pair room"),
        error: [HttpApiError.Forbidden, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.control.revoke",
          summary: "Revoke pair control",
          description: "Return driver control to the host.",
        }),
      ),
      HttpApiEndpoint.get("signalingToken", PairPaths.signalingToken, {
        params: { roomID: Schema.String },
        query: SignalingTokenQuery,
        success: described(PairTicket.ConnectToken, "Pair signaling WebSocket token"),
        error: [HttpApiError.Forbidden, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.signalingToken",
          summary: "Create pair signaling token",
          description: "Create a short-lived ticket for opening a pair signaling WebSocket.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "pair", description: "Real-time pair programming endpoints." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)

export const PairSignalingApi = HttpApi.make("pair-signaling").add(
  HttpApiGroup.make("pair-signaling")
    .add(
      HttpApiEndpoint.get("signaling", PairPaths.signaling, {
        params: RoomParams,
        query: SignalingQuery,
        success: described(Schema.Boolean, "Connected pair signaling socket"),
        error: [HttpApiError.Forbidden, HttpApiError.NotFound],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "pair.signaling",
          summary: "Connect pair signaling socket",
          description: "Open a WebSocket used to broker pair programming signaling messages.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "pair", description: "Pair signaling websocket route." })),
)
