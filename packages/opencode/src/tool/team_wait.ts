import * as Tool from "./tool"
import DESCRIPTION from "./team_wait.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import { Effect, Option, Schema } from "effect"

const Parameters = Schema.Struct({
  timeout_seconds: Schema.optional(Schema.Number).annotate({
    description: "Optional maximum number of seconds to wait for the next teammate message or result",
  }),
})

type Metadata = {
  count: number
  timeout: boolean
  active: boolean
}

export const TeamWaitTool = Tool.define(
  "team_wait",
  Effect.gen(function* () {
    const team = yield* Team.Service
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (!cfg.experimental?.agent_teams) {
            return {
              title: "Team Wait",
              output: "Agent teams disabled.",
              metadata: { count: 0, timeout: false, active: false } as Metadata,
            }
          }

          const activeTeam = yield* team.getActive(ctx.sessionID)
          if (Option.isNone(activeTeam)) {
            return {
              title: "Team Wait",
              output: "No active team.",
              metadata: { count: 0, timeout: false, active: false } as Metadata,
            }
          }
          const teamInfo = activeTeam.value

          const timeoutSeconds = Math.max(1, Math.min(params.timeout_seconds ?? 300, 1_800))
          const deadline = Date.now() + timeoutSeconds * 1_000
          const running = (members: any[]) =>
            members.some((member) => member.status === "starting" || member.status === "active")
          const status = (members: any[]) =>
            members.map(
              (member) => `- ${member.name} (${member.agent_type}, ${member.status}, session ${member.session_id})`,
            )

          function waitForPending(): Effect.Effect<{ messages: any[]; members: any[]; timeout: boolean }> {
            return Effect.gen(function* () {
              const messages = yield* team.getPendingMessages(ctx.sessionID, teamInfo.id)
              const members = yield* team.getMembers(teamInfo.id)
              if (messages.length > 0) return { messages, members, timeout: false }
              if (!running(members)) return { messages, members, timeout: false }
              if (Date.now() >= deadline) return { messages, members, timeout: true }
              yield* Effect.sleep("250 millis")
              return yield* waitForPending()
            })
          }

          const result = yield* waitForPending()
          const active = running(result.members)
          if (result.messages.length === 0) {
            return {
              title: result.timeout ? "Team Wait Timeout" : "Team Wait",
              output: [
                result.timeout
                  ? `Timed out after ${timeoutSeconds} second(s) waiting for teammate updates.`
                  : "No pending teammate updates and no active teammate work is currently running.",
                ...(result.members.length > 0 ? ["", "Current team status:", ...status(result.members)] : []),
              ].join("\n"),
              metadata: { count: 0, timeout: result.timeout, active } as Metadata,
            }
          }

          yield* Effect.forEach(result.messages, (message) => team.markMessageDelivered(message.id, ctx.sessionID), {
            concurrency: "unbounded",
            discard: true,
          })
          const senderName = (sender: string) => {
            if (sender === teamInfo.lead_session_id) return "lead"
            return result.members.find((member) => member.session_id === sender)?.name ?? sender
          }
          const messages = result.messages
            .map((message) => [`From ${senderName(message.sender)} (${message.sender}):`, message.body].join("\n"))
            .join("\n\n---\n\n")

          return {
            title: "Team Wait",
            output: [
              `Received ${result.messages.length} teammate update(s).`,
              "",
              messages,
              ...(result.members.length > 0 ? ["", "Current team status:", ...status(result.members)] : []),
              "",
              "Use these result(s) to coordinate the next step. Do not duplicate work still assigned to active teammates.",
            ].join("\n"),
            metadata: { count: result.messages.length, timeout: false, active } as Metadata,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
