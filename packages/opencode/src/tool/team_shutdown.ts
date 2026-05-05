import * as Tool from "./tool"
import DESCRIPTION from "./team_shutdown.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import { Effect, Schema, Option } from "effect"

const Parameters = Schema.Struct({})

export const TeamShutdownTool = Tool.define(
  "team_shutdown",
  Effect.gen(function* () {
    const team = yield* Team.Service
    const config = yield* Config.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (!cfg.experimental?.agent_teams)
            return { title: "Team Shutdown", output: "Agent teams disabled.", metadata: {} }
          const activeTeam = yield* team.getActive(ctx.sessionID)
          if (Option.isNone(activeTeam)) return { title: "Team Shutdown", output: "No active team.", metadata: {} }
          yield* team.shutdown(activeTeam.value.id)
          return { title: "Team Shut Down", output: "Team shut down successfully.", metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
