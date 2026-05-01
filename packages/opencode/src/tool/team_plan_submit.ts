import * as Tool from "./tool"
import DESCRIPTION from "./team_plan_submit.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import type { TaskPromptOps } from "./task"
import { wakeTeamSession } from "./team_wake"
import { Effect, Schema, Option, Scope } from "effect"

const Parameters = Schema.Struct({
  plan: Schema.String.annotate({ description: "The plan content to submit for approval" }),
})

export const TeamPlanSubmitTool = Tool.define(
  "team_plan_submit",
  Effect.gen(function* () {
    const team = yield* Team.Service
    const config = yield* Config.Service
    const scope = yield* Scope.Scope
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (!cfg.experimental?.agent_teams)
            return { title: "Plan Submit", output: "Agent teams disabled.", metadata: {} }
          const member = yield* team.getMemberBySession(ctx.sessionID)
          if (Option.isNone(member)) return { title: "Plan Submit Failed", output: "Not a team member.", metadata: {} }
          if (!member.value.plan_mode) return { title: "Plan Submit Failed", output: "Not in plan mode.", metadata: {} }
          const info = yield* team.get(member.value.team_id)
          if (Option.isNone(info)) return { title: "Plan Submit Failed", output: "Team not found.", metadata: {} }
          yield* team.sendMessage({
            teamID: member.value.team_id,
            sender: ctx.sessionID,
            recipients: [info.value.lead_session_id],
            body: `PLAN SUBMITTED by ${member.value.name}:\n\n${params.plan}`,
          })
          const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (promptOps) {
            yield* wakeTeamSession(promptOps, info.value.lead_session_id).pipe(Effect.ignore, Effect.forkIn(scope))
          }
          return { title: "Plan Submitted", output: "Plan submitted for lead review.", metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
