import * as Tool from "./tool"
import DESCRIPTION from "./team_task_claim.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import { Effect, Schema, Option } from "effect"

const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({ description: "The task ID to claim" }),
})

export const TeamTaskClaimTool = Tool.define(
  "team_task_claim",
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
            return { title: "Task Claim", output: "Agent teams disabled.", metadata: {} }
          const context = yield* team.getContext(ctx.sessionID)
          if (Option.isNone(context)) return { title: "Task Claim", output: "No active team.", metadata: {} }
          const result = yield* team.claimTask(params.task_id, ctx.sessionID)
          if (Option.isNone(result))
            return { title: "Task Claim Failed", output: "Cannot claim this task.", metadata: {} }
          return { title: "Task Claimed", output: `Task claimed: ${result.value.id.slice(0, 8)}`, metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
