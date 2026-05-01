import * as Tool from "./tool"
import DESCRIPTION from "./team_create.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import { Effect, Schema } from "effect"

const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "Short name for the team" }),
  goal: Schema.String.annotate({ description: "The team's overall goal or mission" }),
})

export const TeamCreateTool = Tool.define(
  "team_create",
  Effect.gen(function* () {
    const team = yield* Team.Service
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
