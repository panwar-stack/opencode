import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const TeamInfoSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  goal: Schema.String,
  lead_session_id: Schema.String,
  status: Schema.String,
  time_created: Schema.Number,
  time_updated: Schema.Number,
}).annotate({ identifier: "TeamInfo" })

const TeamMemberSchema = Schema.Struct({
  id: Schema.String,
  team_id: Schema.String,
  session_id: Schema.String,
  name: Schema.String,
  agent_type: Schema.String,
  role_prompt: Schema.String,
  status: Schema.String,
  plan_mode: Schema.Boolean,
  work_mode: Schema.String,
  dependency_ids: Schema.NullOr(Schema.Array(Schema.String)),
  result: Schema.NullOr(Schema.String),
  time_created: Schema.Number,
  time_updated: Schema.Number,
}).annotate({ identifier: "TeamMember" })

const TeamTaskSchema = Schema.Struct({
  id: Schema.String,
  team_id: Schema.String,
  description: Schema.String,
  status: Schema.String,
  time_created: Schema.Number,
  time_updated: Schema.Number,
}).annotate({ identifier: "TeamTask" })

const TeamMessageSchema = Schema.Struct({
  id: Schema.String,
  team_id: Schema.String,
  sender: Schema.String,
  recipients: Schema.Array(Schema.String),
  body: Schema.String,
  delivery_status: Schema.String,
  time_created: Schema.Number,
  time_updated: Schema.Number,
}).annotate({ identifier: "TeamMessage" })

export const TeamPaths = {
  root: "/team",
} as const

export const TeamQuery = Schema.Struct({
  sessionID: Schema.String,
})

export const TeamApi = HttpApi.make("team")
  .add(
    HttpApiGroup.make("team")
      .add(
        HttpApiEndpoint.get("getBySession", TeamPaths.root, {
          query: TeamQuery,
          success: described(TeamInfoSchema, "Team info"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "team.get",
            summary: "Get team by lead session",
            description: "Get the active team for a given lead session ID.",
          }),
        ),
        HttpApiEndpoint.get("getByTeam", `${TeamPaths.root}/:teamID`, {
          params: { teamID: Schema.String },
          success: described(TeamInfoSchema, "Team info"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "team.getById",
            summary: "Get team by ID",
            description: "Get a team by its team ID.",
          }),
        ),
        HttpApiEndpoint.get("getTasks", `${TeamPaths.root}/:teamID/tasks`, {
          params: { teamID: Schema.String },
          success: described(Schema.Array(TeamTaskSchema), "Team tasks"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "team.tasks",
            summary: "Get team tasks",
            description: "Get all tasks for a team.",
          }),
        ),
        HttpApiEndpoint.get("getMessages", `${TeamPaths.root}/:teamID/messages`, {
          params: { teamID: Schema.String },
          success: described(Schema.Array(TeamMessageSchema), "Team messages"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "team.messages",
            summary: "Get team messages",
            description: "Get all messages for a team.",
          }),
        ),
        HttpApiEndpoint.post("shutdown", `${TeamPaths.root}/:teamID/shutdown`, {
          params: { teamID: Schema.String },
          success: described(Schema.Boolean, "Team shut down"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "team.shutdown",
            summary: "Shutdown team",
            description: "Shutdown a team and cancel all active member sessions.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "team",
          description: "Team orchestration endpoints.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
