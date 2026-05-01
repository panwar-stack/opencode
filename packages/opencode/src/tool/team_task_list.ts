import * as Tool from "./tool"
import DESCRIPTION from "./team_task_list.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import { Effect, Schema, Option } from "effect"

const Parameters = Schema.Struct({})

export const TeamTaskListTool = Tool.define(
  "team_task_list",
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
            return { title: "Team Tasks", output: "Agent teams disabled.", metadata: {} }
          const context = yield* team.getContext(ctx.sessionID)
          if (Option.isNone(context)) return { title: "Team Tasks", output: "No active team.", metadata: {} }
          const tasks = yield* team.getTasks(context.value.team.id)
          if (tasks.length === 0) return { title: "Team Tasks", output: "No tasks found.", metadata: {} }
          const lines = tasks.map(
            (t: any) => `- [${t.status}] ${t.id.slice(0, 8)}: ${t.description}${t.assignee ? ` (${t.assignee})` : ""}`,
          )
          return { title: "Team Tasks", output: lines.join("\n"), metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
