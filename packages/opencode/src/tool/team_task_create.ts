import * as Tool from "./tool"
import DESCRIPTION from "./team_task_create.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import { Effect, Schema, Option } from "effect"

const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "Task description" }),
  assignee: Schema.optional(Schema.String).annotate({ description: "Optional assignee" }),
  dependency_ids: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Optional dependency task IDs",
  }),
})

export const TeamTaskCreateTool = Tool.define(
  "team_task_create",
  Effect.gen(function* () {
    const team = yield* Team.Service
    const config = yield* Config.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (!cfg.experimental?.agent_teams)
            return { title: "Team Task", output: "Agent teams disabled.", metadata: {} }
          const context = yield* team.getContext(ctx.sessionID)
          if (Option.isNone(context)) return { title: "Team Task", output: "No active team.", metadata: {} }
          const task = yield* team.createTask({
            teamID: context.value.team.id,
            description: params.description,
            assignee: params.assignee,
            dependencyIDs: params.dependency_ids ? [...params.dependency_ids] : undefined,
          })
          return {
            title: "Task Created",
            output: `Task: ${task.id.slice(0, 8)} - ${task.description}`,
            metadata: { taskID: task.id },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
