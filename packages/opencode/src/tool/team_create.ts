import * as Tool from "./tool"
import DESCRIPTION from "./team_create.txt"
import { Team } from "@/team/team"
import { Session } from "@/session/session"
import { Config } from "@/config/config"
import { Effect, Option, Schema } from "effect"

const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "Short name for the team" }),
  goal: Schema.String.annotate({ description: "The team's overall goal or mission" }),
})

export const TeamCreateTool = Tool.define(
  "team_create",
  Effect.gen(function* () {
    const team = yield* Team.Service
    const sessions = yield* Session.Service
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (!cfg.experimental?.agent_teams) {
            return { title: "Team Create", output: "Agent teams are not enabled.", metadata: {} }
          }
          const member = yield* team.getMemberBySession(ctx.sessionID)
          if (Option.isSome(member)) {
            const memberTeam = yield* team.get(member.value.team_id)
            if (Option.isSome(memberTeam) && memberTeam.value.status === "active") {
              return {
                title: "Team Create Failed",
                output: "Team members cannot create nested teams.",
                metadata: {},
              }
            }
          }
          const session = yield* sessions.get(ctx.sessionID)
          if (session.parentID) {
            return {
              title: "Team Create Failed",
              output: "Child sessions cannot create teams.",
              metadata: {},
            }
          }
          const info = yield* team.create({
            name: params.name,
            goal: params.goal,
            leadSessionID: ctx.sessionID,
          })
          return {
            title: "Team Created",
            output: JSON.stringify({ teamID: info.id, name: info.name, status: info.status }, null, 2),
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
