import * as Tool from "./tool"
import DESCRIPTION from "./team_get_messages.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import { Effect, Option, Schema } from "effect"

const Parameters = Schema.Struct({})

export const TeamGetMessagesTool = Tool.define(
  "team_get_messages",
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
            return { title: "Team Messages", output: "Agent teams disabled.", metadata: { count: 0 } }
          const context = yield* team.getContext(ctx.sessionID)
          if (Option.isNone(context))
            return { title: "Team Messages", output: "No active team.", metadata: { count: 0 } }
          const messages = yield* team.getPendingMessages(ctx.sessionID, context.value.team.id)
          if (messages.length === 0)
            return { title: "Team Messages", output: "No pending messages.", metadata: { count: 0 } }

          yield* Effect.forEach(messages, (message) => team.markMessageDelivered(message.id, ctx.sessionID), {
            concurrency: "unbounded",
            discard: true,
          })
          const members = yield* team.getMembers(context.value.team.id)
          const senderName = (sender: string) => {
            if (sender === context.value.team.lead_session_id) return "lead"
            return members.find((member) => member.session_id === sender)?.name ?? sender
          }

          return {
            title: "Team Messages",
            output: messages
              .map((message) => [`From ${senderName(message.sender)} (${message.sender}):`, message.body].join("\n"))
              .join("\n\n---\n\n"),
            metadata: { count: messages.length },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
