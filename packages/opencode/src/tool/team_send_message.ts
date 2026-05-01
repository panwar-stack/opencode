import * as Tool from "./tool"
import DESCRIPTION from "./team_send_message.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import type { TaskPromptOps } from "./task"
import { wakeTeamSession } from "./team_wake"
import { Effect, Option, Schema, Scope } from "effect"

const Parameters = Schema.Struct({
  recipient: Schema.String.annotate({ description: "The name or sessionID of the teammate" }),
  body: Schema.String.annotate({ description: "The message body" }),
})

export const TeamSendMessageTool = Tool.define(
  "team_send_message",
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
            return { title: "Team Message", output: "Agent teams disabled.", metadata: {} }
          const context = yield* team.getContext(ctx.sessionID)
          if (Option.isNone(context)) return { title: "Team Message", output: "No active team.", metadata: {} }
          const members = yield* team.getMembers(context.value.team.id)
          const requested = params.recipient
            .split(",")
            .map((recipient) => recipient.trim())
            .filter((recipient) => recipient.length > 0)
          const recipientIDs = requested
            .map((recipient) => {
              if (recipient === "lead" || recipient === "lead_session" || recipient === "lead_session_id") {
                return context.value.team.lead_session_id
              }
              return members.find((member) => member.name === recipient || member.session_id === recipient)?.session_id
            })
            .filter((recipient): recipient is string => recipient !== undefined)
          const missing = requested.filter((recipient) => {
            if (recipient === "lead" || recipient === "lead_session" || recipient === "lead_session_id") return false
            return !members.some((member) => member.name === recipient || member.session_id === recipient)
          })
          if (missing.length > 0) {
            return { title: "Team Message", output: `Recipient '${missing.join(", ")}' not found.`, metadata: {} }
          }
          const recipients = [...new Set(recipientIDs)]
          if (recipients.length === 0) return { title: "Team Message", output: "No recipients.", metadata: {} }
          const msg = yield* team.sendMessage({
            teamID: context.value.team.id,
            sender: ctx.sessionID,
            recipients,
            body: params.body,
          })
          const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (promptOps) {
            yield* Effect.forEach(
              recipients.filter((recipient) => recipient !== ctx.sessionID),
              (recipient) => wakeTeamSession(promptOps, recipient).pipe(Effect.ignore, Effect.forkIn(scope)),
              { discard: true },
            )
          }
          return {
            title: "Message Sent",
            output: `Sent to ${recipients.length} recipient(s)`,
            metadata: { messageID: msg.id },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
