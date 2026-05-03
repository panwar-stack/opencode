import * as Tool from "./tool"
import DESCRIPTION from "./team_get_messages.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
// Used to inspect stored tool parts when guarding against repeated empty mailbox polls.
import { MessageV2 } from "@/session/message-v2"
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
          // Keep metadata shape stable for callers even when team messaging is unavailable.
          if (!cfg.experimental?.agent_teams)
            return { title: "Team Messages", output: "Agent teams disabled.", metadata: { count: 0, repeated: false } }
          const context = yield* team.getContext(ctx.sessionID)
          // A missing team is still an empty read, not a repeated-poll signal.
          if (Option.isNone(context))
            return { title: "Team Messages", output: "No active team.", metadata: { count: 0, repeated: false } }
          const messages = yield* team.getPendingMessages(ctx.sessionID, context.value.team.id)
          // Members are needed for both empty-mailbox status summaries and sender labels below.
          const members = yield* team.getMembers(context.value.team.id)
          // Include member status in empty-mailbox guidance so the lead can see work is still active without polling.
          const status = members.map(
            (member) => `- ${member.name} (${member.agent_type}, ${member.status}, session ${member.session_id})`,
          )
          // Empty polling can span multiple assistant messages in one user turn, so inspect both prior
          // completed tool parts from the turn history and the current assistant message.
          const lastUser = ctx.messages.findLast((message) => message.info.role === "user")
          const previousParts = [
            ...ctx.messages
              .filter(
                (message) => message.info.role === "assistant" && (!lastUser || message.info.id > lastUser.info.id),
              )
              .flatMap((message) => message.parts),
            ...MessageV2.parts(ctx.messageID),
          ]
          // Count only completed empty reads, so actual pending messages still deliver normally.
          const previousEmptyChecks = previousParts.filter(
            (part) =>
              part.type === "tool" &&
              part.tool === "team_get_messages" &&
              part.callID !== ctx.callID &&
              part.state.status === "completed" &&
              part.state.metadata.count === 0,
          ).length
          if (messages.length === 0) {
            // An empty mailbox is not a wait primitive; steer participants back to ending the turn or continuing work.
            const lead = ctx.sessionID === context.value.team.lead_session_id
            const guidance = lead
              ? [
                  "No pending messages.",
                  previousEmptyChecks > 0
                    ? "Repeated empty mailbox check suppressed. End this turn now instead of polling."
                    : "Check complete. If teammates are still active, end this turn instead of polling.",
                  "Team messages are delivered asynchronously; busy teammates can only process broadcasts or direct messages at their next prompt boundary.",
                  "Do not send routine status-check broadcasts just because the mailbox is empty. Teammates will wake you when they have progress, blockers, or results.",
                ]
              : [
                  "No pending messages.",
                  previousEmptyChecks > 0
                    ? "Repeated empty mailbox check suppressed. Continue your assigned work instead of polling."
                    : "Check complete. Continue your assigned work instead of polling.",
                ]
            return {
              title: previousEmptyChecks > 0 ? "Team Messages (Polling Blocked)" : "Team Messages",
              output: [...guidance, ...(status.length > 0 ? ["", "Current team status:", ...status] : [])].join("\n"),
              metadata: { count: 0, repeated: previousEmptyChecks > 0 },
            }
          }

          // Once messages are returned, preserve normal delivery semantics by marking only this recipient delivered.
          yield* Effect.forEach(messages, (message) => team.markMessageDelivered(message.id, ctx.sessionID), {
            concurrency: "unbounded",
            discard: true,
          })
          const senderName = (sender: string) => {
            if (sender === context.value.team.lead_session_id) return "lead"
            return members.find((member) => member.session_id === sender)?.name ?? sender
          }

          return {
            title: "Team Messages",
            output: messages
              .map((message) => [`From ${senderName(message.sender)} (${message.sender}):`, message.body].join("\n"))
              .join("\n\n---\n\n"),
            // Non-empty reads are never polling violations; the flag is for empty-read guardrails only.
            metadata: { count: messages.length, repeated: false },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
