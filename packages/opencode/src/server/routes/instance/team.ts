import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { describeRoute, resolver, validator } from "hono-openapi"
import { Option } from "effect"
import z from "zod"
import { Team } from "@/team/team"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"

const TeamInfo = z
  .object({
    id: z.string(),
    name: z.string(),
    goal: z.string(),
    lead_session_id: z.string(),
    status: z.string(),
    time_created: z.number(),
    time_updated: z.number(),
  })
  .meta({ ref: "TeamInfo" })

const TeamTask = z
  .object({
    id: z.string(),
    team_id: z.string(),
    description: z.string(),
    status: z.string(),
    time_created: z.number(),
    time_updated: z.number(),
  })
  .meta({ ref: "TeamTask" })

const TeamMessage = z
  .object({
    id: z.string(),
    team_id: z.string(),
    sender: z.string(),
    recipients: z.string().array(),
    body: z.string(),
    delivery_status: z.string(),
    time_created: z.number(),
    time_updated: z.number(),
  })
  .meta({ ref: "TeamMessage" })

export const TeamRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get team by lead session",
        description: "Get the active team for a given lead session ID.",
        operationId: "team.get",
        responses: {
          200: {
            description: "Team info",
            content: {
              "application/json": {
                schema: resolver(TeamInfo),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("query", z.object({ sessionID: z.string() })),
      async (c) =>
        jsonRequest("TeamRoutes.get", c, function* () {
          const team = yield* Team.Service
          const result = yield* team.getActive(c.req.valid("query").sessionID)
          if (Option.isNone(result)) throw new HTTPException(400)
          return result.value
        }),
    )
    .get(
      "/:teamID",
      describeRoute({
        summary: "Get team by ID",
        description: "Get a team by its team ID.",
        operationId: "team.getById",
        responses: {
          200: {
            description: "Team info",
            content: {
              "application/json": {
                schema: resolver(TeamInfo),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ teamID: z.string() })),
      async (c) =>
        jsonRequest("TeamRoutes.getById", c, function* () {
          const team = yield* Team.Service
          const result = yield* team.get(c.req.valid("param").teamID)
          if (Option.isNone(result)) throw new HTTPException(400)
          return result.value
        }),
    )
    .get(
      "/:teamID/messages",
      describeRoute({
        summary: "Get team messages",
        description: "Get all messages for a team.",
        operationId: "team.messages",
        responses: {
          200: {
            description: "Team messages",
            content: {
              "application/json": {
                schema: resolver(TeamMessage.array()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ teamID: z.string() })),
      async (c) =>
        jsonRequest("TeamRoutes.messages", c, function* () {
          const team = yield* Team.Service
          return yield* team.getMessages(c.req.valid("param").teamID)
        }),
    )
    .get(
      "/:teamID/tasks",
      describeRoute({
        summary: "Get team tasks",
        description: "Get all tasks for a team.",
        operationId: "team.tasks",
        responses: {
          200: {
            description: "Team tasks",
            content: {
              "application/json": {
                schema: resolver(TeamTask.array()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ teamID: z.string() })),
      async (c) =>
        jsonRequest("TeamRoutes.tasks", c, function* () {
          const team = yield* Team.Service
          return yield* team.getTasks(c.req.valid("param").teamID)
        }),
    )
    .post(
      "/:teamID/shutdown",
      describeRoute({
        summary: "Shutdown team",
        description: "Shutdown a team and cancel all active member sessions.",
        operationId: "team.shutdown",
        responses: {
          200: {
            description: "Team shut down",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ teamID: z.string() })),
      async (c) =>
        jsonRequest("TeamRoutes.shutdown", c, function* () {
          const team = yield* Team.Service
          yield* team.shutdown(c.req.valid("param").teamID)
          return true
        }),
    ),
)
