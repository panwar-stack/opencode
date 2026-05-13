import { Schema, Effect, Option } from "effect"
import { eq } from "drizzle-orm"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import * as Tool from "./tool"
import DESCRIPTION from "./team_report.txt"
import { Database } from "@/storage/db"
import { TeamTable, TeamMessageRecipientTable } from "@/team/team.sql"
import { SessionTable } from "@/session/session.sql"

const Parameters = Schema.Struct({
  team_id: Schema.optional(Schema.String).annotate({
    description: "Team ID to report on. Omit to auto-detect the active team for the lead session.",
  }),
  lead_session_id: Schema.optional(Schema.String).annotate({
    description:
      "Lead session ID used when no team_id is provided and team context is unavailable in the current session.",
  }),
  compare_session_ids: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description:
        "Optional lead session IDs to compare against this team run (subagent-only or direct baseline sessions).",
    }),
  ),
})

function pct(value: number, total: number) {
  return total === 0 ? 0 : (value / total) * 100
}

function durationText(ms: number) {
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const min = sec / 60
  if (min < 60) return `${min.toFixed(1)}m`
  return `${(min / 60).toFixed(1)}h`
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export const TeamReportTool = Tool.define(
  "team_report",
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
            return { title: "Team Report", output: "Agent teams are disabled." }
          }

          const context = yield* team.getContext(ctx.sessionID)
          const leadSessionID = params.lead_session_id ??
            (Option.isSome(context) ? context.value.team.lead_session_id : undefined)
          const explicitTeam = params.team_id
            ? Database.use(() =>
                Database.Client()
                  .select()
                  .from(TeamTable)
                  .where(eq(TeamTable.id, params.team_id))
                  .get(),
              )
            : undefined
          const latestTeamForLead = leadSessionID
            ? (() => {
                const rows = Database.use(() =>
                  Database.Client()
                    .select()
                    .from(TeamTable)
                    .where(eq(TeamTable.lead_session_id, leadSessionID))
                    .all(),
                )
                rows.sort((a, b) => b.time_updated - a.time_updated)
                return rows[0]
              })()
            : undefined
          const teams = params.team_id ? explicitTeam : latestTeamForLead

          if (!teams) {
            return {
              title: "Team Report",
              output: [
                "No team could be resolved from this session.",
                "Pass team_id explicitly, or run this tool from a lead session with an active team.",
                "You can also provide lead_session_id for a historical team.",
              ].join("\n"),
            }
          }

          yield* ctx.ask({
            permission: "team_report",
            patterns: [teams.id],
            always: [teams.id],
            metadata: { team_id: teams.id, lead_session_id: teams.lead_session_id },
          })

          const members = yield* team.getMembers(teams.id)
          const tasks = yield* team.getTasks(teams.id)
          const messages = yield* team.getMessages(teams.id)
          const recipients = Database.use(() =>
            Database.Client()
              .select()
              .from(TeamMessageRecipientTable)
              .where(eq(TeamMessageRecipientTable.team_id, teams.id))
              .all(),
          )

          const teamSessionRows = yield* Effect.forEach(
            Array.from(new Set([teams.lead_session_id, ...members.map((member) => member.session_id)])),
            (sessionID) =>
              Effect.sync(() =>
                Database.use(() =>
                  Database.Client()
                    .select()
                    .from(SessionTable)
                    .where(eq(SessionTable.id, sessionID))
                    .get(),
                ),
              ),
            { concurrency: "unbounded" },
          ).pipe(
            Effect.map((rows) => rows.filter((row): row is NonNullable<(typeof rows)[number]> => row !== undefined)),
          )

          const compareRows = yield* Effect.forEach(
            Array.from(new Set(params.compare_session_ids ?? [])),
            (sessionID) =>
              Effect.sync(() =>
                Database.use(() =>
                  Database.Client()
                    .select()
                    .from(SessionTable)
                    .where(eq(SessionTable.id, sessionID))
                    .get(),
                ),
              ),
            { concurrency: "unbounded" },
          ).pipe(
            Effect.map((rows) => rows.filter((row): row is NonNullable<(typeof rows)[number]> => row !== undefined)),
          )
          const compareChildren = yield* Effect.forEach(
            compareRows,
            (row) =>
              Effect.sync(() =>
                Database.use(() =>
                  Database.Client()
                    .select()
                    .from(SessionTable)
                    .where(eq(SessionTable.parent_id, row.id))
                    .all(),
                ),
              ),
            { concurrency: "unbounded" },
          )
          const compareChildCountBySession = new Map(
            compareRows.map((row, index) => [row.id, compareChildren[index].length]),
          )
          const compareChildRowsBySession = new Map(compareRows.map((row, index) => [row.id, compareChildren[index]]))

          const teamWindowMs = teams.time_updated - teams.time_created
          const totalMemberRuntime = members.reduce((acc, item) => acc + (item.time_updated - item.time_created), 0)
          const completedMembers = members.filter((member) => member.status === "completed")
          const canceledMembers = members.filter((member) => member.status === "cancelled")
          const blockedMembers = members.filter((member) => member.status === "blocked")
          const memberDependencyDefined = members.filter((member) => !!member.dependency_ids?.length)
          const activeMembers = members.filter((member) => member.status === "active")
          const startedMembers = members.filter((member) => member.status === "starting")
          const completedRuntime = completedMembers.map((member) => member.time_updated - member.time_created)
          const memberRuntimeP50 = median(completedRuntime)
          const memberRuntimeAvg = completedRuntime.length === 0 ? 0 : completedRuntime.reduce((acc, item) => acc + item, 0) /
            completedRuntime.length
          const parallelism = teamWindowMs === 0 ? 0 : totalMemberRuntime / teamWindowMs

          const completedTasks = tasks.filter((item) => item.status === "completed")
          const canceledTasks = tasks.filter((item) => item.status === "cancelled")
          const inProgressTasks = tasks.filter((item) => item.status === "in_progress")
          const pendingTasks = tasks.filter((item) => item.status === "pending")
          const taskDependencyDefined = tasks.filter((task) => !!task.dependency_ids?.length)

          const messageDelivered = recipients.filter((item) => item.delivery_status === "delivered")
          const messageRead = recipients.filter((item) => item.delivery_status === "read")
          const messagePending = recipients.filter((item) => item.delivery_status === "pending")
          const messageCreatedAt = new Map(messages.map((message) => [message.id, message.time_created]))
          const messageDeliveryMs = recipients
            .filter((recipient) => recipient.delivery_status !== "pending")
            .flatMap((recipient) => {
              const created = messageCreatedAt.get(recipient.message_id)
              if (!created) return []
              return [recipient.time_updated - created]
            })
          const messageDeliveryAvg = messageDeliveryMs.length === 0
            ? 0
            : messageDeliveryMs.reduce((acc, item) => acc + item, 0) / messageDeliveryMs.length
          const messageDeliveryP50 = median(messageDeliveryMs)

          const teamSessionRuntime = teamSessionRows.reduce((acc, session) => acc + (session.time_updated - session.time_created), 0)
          const teamSessionCost = teamSessionRows.reduce((acc, session) => acc + session.cost, 0)
          const teamSessionTokens = teamSessionRows.reduce(
            (acc, session) => ({
              input: acc.input + session.tokens_input,
              output: acc.output + session.tokens_output,
              reasoning: acc.reasoning + session.tokens_reasoning,
              cache_read: acc.cache_read + session.tokens_cache_read,
              cache_write: acc.cache_write + session.tokens_cache_write,
            }),
            {
              input: 0,
              output: 0,
              reasoning: 0,
              cache_read: 0,
              cache_write: 0,
            },
          )

          const leadSummary = teamSessionRows.find((row) => row.id === teams.lead_session_id)
          const memberSessions = teamSessionRows.filter((row) => row.id !== teams.lead_session_id)

          const comparison = compareRows.map((session) => {
            const childCount = compareChildCountBySession.get(session.id) ?? 0
            const childRows = compareChildRowsBySession.get(session.id) ?? []
            const childCost = childRows.reduce((acc, row) => acc + row.cost, 0)
            const childTokens = childRows.reduce(
              (acc, row) => ({
                input: acc.input + row.tokens_input,
                output: acc.output + row.tokens_output,
                reasoning: acc.reasoning + row.tokens_reasoning,
                cache_read: acc.cache_read + row.tokens_cache_read,
                cache_write: acc.cache_write + row.tokens_cache_write,
              }),
              { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
            )
            return [
              `- ${session.id}`,
              `  title: ${session.title}`,
              `  duration: ${durationText(session.time_updated - session.time_created)}`,
              `  total cost: ${session.cost.toFixed(2)}`,
              `  lead tokens: in ${session.tokens_input}, out ${session.tokens_output}, reasoning ${session.tokens_reasoning}`,
              `  child sessions: ${childCount}`,
              `  child cost: ${childCost.toFixed(2)}`,
              `  child tokens: in ${childTokens.input}, out ${childTokens.output}, reasoning ${childTokens.reasoning}`,
            ].join("\n")
          })

          const insights = [
            blockedMembers.length > 0
              ? `Dependency or wait states appeared in ${pct(blockedMembers.length, members.length).toFixed(1)}% of team members.`
              : "No members were blocked at report time.",
            pct(canceledMembers.length, members.length) > 20
              ? "Cancellation rate is high; check dependency chains or spawn gating in lead orchestration."
              : "Member completion and cancellation rates look stable.",
            messageRead.length > 0
              ? `Mailbox reads captured for ${pct(messageRead.length, recipients.length).toFixed(1)}% of recipient deliveries.`
              : "No read-marked mailbox rows were found.",
          ]

          const output = [
            "# Team Effectiveness Report",
            "",
            `Team: ${teams.name}`,
            `Goal: ${teams.goal}`,
            `Team ID: ${teams.id}`,
            `Lead session: ${teams.lead_session_id}`,
            `Status: ${teams.status}`,
            `Team window: ${durationText(teamWindowMs)}`,
            "",
            "## Team throughput",
            `- members: ${members.length}`,
            `- completed: ${completedMembers.length} (${pct(completedMembers.length, members.length).toFixed(1)}%)`,
            `- cancelled: ${canceledMembers.length} (${pct(canceledMembers.length, members.length).toFixed(1)}%)`,
            `- blocked: ${blockedMembers.length} (${pct(blockedMembers.length, members.length).toFixed(1)}%)`,
            `- active now: ${activeMembers.length} (${pct(activeMembers.length, members.length).toFixed(1)}%)`,
            `- starting now: ${startedMembers.length} (${pct(startedMembers.length, members.length).toFixed(1)}%)`,
            `- with dependencies declared: ${memberDependencyDefined.length} (${pct(memberDependencyDefined.length, members.length).toFixed(1)}%)`,
            `- total member runtime: ${durationText(totalMemberRuntime)}`,
            `- completed member runtime avg/p50: ${durationText(memberRuntimeAvg)} / ${durationText(memberRuntimeP50)}`,
            `- parallelism ratio: ${parallelism.toFixed(2)} (higher is better within task constraints)`,
            "",
            "## Tasks",
            `- tasks: ${tasks.length}`,
            `- pending: ${pendingTasks.length}`,
            `- in-progress: ${inProgressTasks.length}`,
            `- completed: ${completedTasks.length} (${pct(completedTasks.length, tasks.length).toFixed(1)}%)`,
            `- cancelled: ${canceledTasks.length} (${pct(canceledTasks.length, tasks.length).toFixed(1)}%)`,
            `- with dependencies: ${taskDependencyDefined.length} (${pct(taskDependencyDefined.length, tasks.length).toFixed(1)}%)`,
            "",
            "## Messaging",
            `- messages: ${messages.length}`,
            `- recipient rows: ${recipients.length}`,
            `- delivered: ${messageDelivered.length} (${pct(messageDelivered.length, recipients.length).toFixed(1)}%)`,
            `- read: ${messageRead.length} (${pct(messageRead.length, recipients.length).toFixed(1)}%)`,
            `- pending: ${messagePending.length} (${pct(messagePending.length, recipients.length).toFixed(1)}%)`,
            `- message delivery avg/p50: ${durationText(messageDeliveryAvg)} / ${durationText(messageDeliveryP50)}`,
            "",
            "## Cost and latency",
            `- sessions included: ${teamSessionRows.length} (lead ${leadSummary ? "present" : "missing"}, members ${memberSessions.length})`,
            `- total session runtime: ${durationText(teamSessionRuntime)}`,
            `- total cost: ${teamSessionCost.toFixed(2)}`,
            `- total tokens: in ${teamSessionTokens.input}, out ${teamSessionTokens.output}, reasoning ${teamSessionTokens.reasoning}`,
            `- cache tokens: read ${teamSessionTokens.cache_read}, write ${teamSessionTokens.cache_write}`,
            "",
            "## Insights",
            ...insights,
            "",
            "## Comparison sessions (optional baselines)",
            ...(comparison.length === 0 ? ["No comparison sessions supplied. Pass compare_session_ids to benchmark direct or subagent-only runs."] : comparison),
          ].join("\n")

          return {
            title: `Team Report: ${teams.name}`,
            metadata: {
              team_id: teams.id,
              lead_session_id: teams.lead_session_id,
              generated_at: Date.now(),
              throughput: {
                team_window_ms: teamWindowMs,
                member_count: members.length,
                completed_member_count: completedMembers.length,
                cancelled_member_count: canceledMembers.length,
                blocked_member_count: blockedMembers.length,
                parallelism,
              },
              tasks: {
                total: tasks.length,
                completed: completedTasks.length,
                cancelled: canceledTasks.length,
                in_progress: inProgressTasks.length,
                pending: pendingTasks.length,
              },
              messages: {
                total: messages.length,
                recipient_count: recipients.length,
                delivered: messageDelivered.length,
                read: messageRead.length,
                pending: messagePending.length,
              },
              costs: {
                cost: teamSessionCost,
                tokens: teamSessionTokens,
              },
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
