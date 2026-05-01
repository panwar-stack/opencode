import * as Tool from "./tool"
import DESCRIPTION from "./team_broadcast.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import type { TaskPromptOps } from "./task"
import { wakeTeamSession } from "./team_wake"
import { Effect, Option, Schema, Scope } from "effect"

const Parameters = Schema.Struct({
  body: Schema.String.annotate({ description: "The message body" }),
})

export const TeamBroadcastTool = Tool.define(
  "team_broadcast",
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
            return { title: "Team Broadcast", output: "Agent teams disabled.", metadata: {} }
          const context = yield* team.getContext(ctx.sessionID)
          if (Option.isNone(context)) return { title: "Team Broadcast", output: "No active team.", metadata: {} }
          const members = yield* team.getMembers(context.value.team.id)
          const activeMembers = members.filter(
            (member) => member.status === "active" || member.status === "starting" || member.status === "idle",
          )
          const recipients = [
            ...new Set(
              [context.value.team.lead_session_id, ...activeMembers.map((member) => member.session_id)].filter(
                (sessionID) => sessionID !== ctx.sessionID,
              ),
            ),
          ]
          if (recipients.length === 0) return { title: "Team Broadcast", output: "No active teammates.", metadata: {} }
          const msg = yield* team.sendMessage({
            teamID: context.value.team.id,
            sender: ctx.sessionID,
            recipients,
            body: params.body,
          })
          const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (promptOps) {
            yield* Effect.forEach(
              recipients,
              (recipient) => wakeTeamSession(promptOps, recipient).pipe(Effect.ignore, Effect.forkIn(scope)),
              { discard: true },
            )
          }
          return {
            title: "Broadcast Sent",
            output: `Sent to ${recipients.length} recipient(s)`,
            metadata: { messageID: msg.id },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
