import * as Tool from "./tool"
import DESCRIPTION from "./team_plan_decide.txt"
import { Team } from "@/team/team"
import { Session } from "@/session/session"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import type { TaskPromptOps } from "./task"
import { wakeTeamSession } from "./team_wake"
import { Effect, Option, Schema } from "effect"

const Parameters = Schema.Struct({
  member_name: Schema.String.annotate({ description: "Teammate name" }),
  decision: Schema.Literals(["approve", "reject"]).annotate({ description: "approve or reject" }),
  feedback: Schema.optional(Schema.String).annotate({ description: "Feedback for the teammate" }),
})

export const TeamPlanDecideTool = Tool.define(
  "team_plan_decide",
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
          if (!cfg.experimental?.agent_teams)
            return { title: "Plan Decide", output: "Agent teams disabled.", metadata: {} }
          const activeTeam = yield* team.getActive(ctx.sessionID)
          if (Option.isNone(activeTeam)) return { title: "Plan Decide Failed", output: "No active team.", metadata: {} }
          const members = yield* team.getMembers(activeTeam.value.id)
          const target = members.find((m: any) => m.name === params.member_name)
          if (!target) return { title: "Plan Decide Failed", output: `No member '${params.member_name}'`, metadata: {} }

          if (params.decision === "approve") {
            yield* team.updateMemberStatus(target.id, "active")
            const session = yield* sessions.get(target.session_id)
            const newPermission = (session.permission ?? []).filter(
              (rule: Permission.Rule) =>
                !(
                  rule.action === "deny" &&
                  rule.pattern === "*" &&
                  (rule.permission === "edit" ||
                    rule.permission === "write" ||
                    rule.permission === "bash" ||
                    rule.permission === "apply_patch")
                ),
            )
            yield* sessions.setPermission({ sessionID: target.session_id, permission: newPermission })
            yield* team.sendMessage({
              teamID: activeTeam.value.id,
              sender: ctx.sessionID,
              recipients: [target.session_id],
              body: `PLAN APPROVED. Proceed with implementation.\n${params.feedback ?? ""}`,
            })
            const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined
            if (promptOps) {
              yield* wakeTeamSession(promptOps, target.session_id).pipe(Effect.ignore)
            }
            return { title: "Plan Approved", output: `Plan for ${params.member_name} approved.`, metadata: {} }
          }
          yield* team.sendMessage({
            teamID: activeTeam.value.id,
            sender: ctx.sessionID,
            recipients: [target.session_id],
            body: `PLAN REJECTED.\n${params.feedback ?? "Please revise and resubmit."}`,
          })
          const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (promptOps) {
            yield* wakeTeamSession(promptOps, target.session_id).pipe(Effect.ignore)
          }
          return { title: "Plan Rejected", output: `Plan for ${params.member_name} rejected.`, metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
