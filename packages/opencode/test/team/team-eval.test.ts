import { describe, expect } from "bun:test"
import { Bus } from "@/bus"
import { Database } from "@/storage/db"
import { TeamEval, type TeamEvalFindingCategory, type TeamEvalReport } from "@/team/eval"
import { Team } from "@/team/team"
import { TeamTable } from "@/team/team.sql"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Team.defaultLayer, Bus.layer, CrossSpawnSpawner.defaultLayer))

describe("team eval", () => {
  it.live("builds team DAG nodes and edges", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "eval-dag", goal: "Build a DAG", leadSessionID: "ses_eval_lead_dag" })
        const first = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_dag_first",
          name: "first",
          agentType: "general",
          rolePrompt: "Do first work",
        })
        const second = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_dag_second",
          name: "second",
          agentType: "general",
          rolePrompt: "Do second work",
          dependencyIDs: [first.session_id],
        })
        const firstTask = yield* team.createTask({ teamID: info.id, description: "First task" })
        const secondTask = yield* team.createTask({
          teamID: info.id,
          description: "Second task",
          dependencyIDs: [firstTask.id],
        })
        const message = yield* team.sendMessage({
          teamID: info.id,
          sender: info.lead_session_id,
          recipients: [second.session_id],
          body: "Please continue after first.",
        })

        yield* team.updateMemberStatus(first.id, "completed", "first result")

        const report = yield* TeamEval.build(info.id)

        expect(report.nodes.some((item) => item.id === node("team", info.id))).toBe(true)
        expect(report.nodes.some((item) => item.id === node("member", first.session_id))).toBe(true)
        expect(report.nodes.some((item) => item.id === node("task", secondTask.id))).toBe(true)
        expect(report.nodes.some((item) => item.id === node("message", message.id))).toBe(true)
        expect(report.nodes.some((item) => item.id === node("result", first.session_id))).toBe(true)
        expect(report.edges).toContainEqual(
          expect.objectContaining({
            type: "depends_on",
            from: node("member", first.session_id),
            to: node("member", second.session_id),
          }),
        )
        expect(report.edges).toContainEqual(
          expect.objectContaining({ type: "depends_on", from: node("task", firstTask.id), to: node("task", secondTask.id) }),
        )
        expect(report.edges).toContainEqual(
          expect.objectContaining({
            type: "message_to",
            from: node("team", info.id),
            to: node("member", second.session_id),
          }),
        )
        expect(report.edges).toContainEqual(
          expect.objectContaining({ type: "produces", from: node("member", first.session_id), to: node("result", first.session_id) }),
        )
        expect(report.summary.longest_dependency_chain).toBe(1)
      }),
    ),
  )

  it.live("reports missing dependencies and empty results", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "eval-findings", goal: "Find deterministic failures", leadSessionID: "ses_eval_lead_findings" })
        const empty = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_empty_result",
          name: "empty",
          agentType: "general",
          rolePrompt: "Complete without a result",
        })
        yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_missing_member_dep",
          name: "missing-dep",
          agentType: "general",
          rolePrompt: "Depend on a missing member",
          dependencyIDs: ["ses_eval_missing_dependency"],
        })
        yield* team.createTask({
          teamID: info.id,
          description: "Task with missing dependency",
          dependencyIDs: ["task_missing_dependency"],
        })

        yield* team.updateMemberStatus(empty.id, "completed")

        const report = yield* TeamEval.build(info.id)

        expect(categories(report).filter((category) => category === "planning.missing_or_wrong_dependency").length).toBe(2)
        expect(categories(report)).toContain("execution.empty_result")
        expect(finding(report, "execution.empty_result")?.root_cause).toBe(true)
        expect(report.summary.root_cause_count).toBe(3)
      }),
    ),
  )

  it.live("propagates cancelled dependency to blocked dependent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "eval-propagation", goal: "Propagate failures", leadSessionID: "ses_eval_lead_propagation" })
        const upstream = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_cancelled_upstream",
          name: "upstream",
          agentType: "general",
          rolePrompt: "Fail upstream",
        })
        const dependent = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_blocked_dependent",
          name: "dependent",
          agentType: "general",
          rolePrompt: "Wait for upstream",
          dependencyIDs: [upstream.session_id],
        })

        yield* team.updateMemberStatus(upstream.id, "cancelled")
        yield* team.updateMemberStatus(dependent.id, "blocked")

        const report = yield* TeamEval.build(info.id)
        const blocked = finding(report, "execution.stuck_or_blocked", node("member", dependent.session_id))

        expect(finding(report, "execution.cancelled_member", node("member", upstream.session_id))?.root_cause).toBe(true)
        expect(blocked?.root_cause).toBe(false)
        expect(blocked?.propagated_from).toBe(node("member", upstream.session_id))
        expect(report.edges).toContainEqual(
          expect.objectContaining({
            type: "propagates_to",
            from: node("member", upstream.session_id),
            to: node("member", dependent.session_id),
          }),
        )
      }),
    ),
  )

  it.live("does not propagate through containment or lead spawn edges", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "eval-local-failures", goal: "Keep local failures local", leadSessionID: "ses_eval_lead_local" })
        const active = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_active_at_close",
          name: "active",
          agentType: "general",
          rolePrompt: "Stay active",
        })
        const cancelled = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_local_cancelled",
          name: "cancelled",
          agentType: "general",
          rolePrompt: "Cancel locally",
        })

        yield* team.updateMemberStatus(active.id, "active")
        yield* team.updateMemberStatus(cancelled.id, "cancelled")
        closeTeam(info.id)

        const report = yield* TeamEval.build(info.id)

        expect(finding(report, "integration.premature_shutdown", node("team", info.id))?.root_cause).toBe(true)
        expect(finding(report, "execution.cancelled_member", node("member", cancelled.session_id))?.root_cause).toBe(true)
        expect(finding(report, "execution.cancelled_member", node("member", cancelled.session_id))?.propagated_from).toBeUndefined()
      }),
    ),
  )

  it.live("reports pending delivery after close and expected edge deviations", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "eval-closed-message", goal: "Find pending messages", leadSessionID: "ses_eval_lead_pending" })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_pending_recipient",
          name: "recipient",
          agentType: "general",
          rolePrompt: "Receive message",
        })

        yield* team.updateMemberStatus(member.id, "completed", "recipient result")
        yield* team.sendMessage({
          teamID: info.id,
          sender: info.lead_session_id,
          recipients: [member.session_id],
          body: "Pending when closed",
        })
        closeTeam(info.id)

        const report = yield* TeamEval.build(info.id, {
          expectedEdges: [{ type: "depends_on", from: node("member", "missing-a"), to: node("member", "missing-b") }],
        })

        expect(categories(report)).toContain("messaging.pending_delivery")
        expect(categories(report)).toContain("structure.unexpected_or_missing_edge")
        expect(report.summary.structural_deviation_count).toBe(1)
      }),
    ),
  )
})

function finding(report: TeamEvalReport, category: TeamEvalFindingCategory, nodeID?: string) {
  return report.findings.find((item) => item.category === category && (nodeID === undefined || item.node_id === nodeID))
}

function categories(report: TeamEvalReport) {
  return report.findings.map((item) => item.category)
}

function closeTeam(teamID: string) {
  Database.use(() =>
    Database.Client()
      .update(TeamTable)
      .set({ status: "closed", time_updated: Date.now() })
      .where(eq(TeamTable.id, teamID))
      .run(),
  )
}

function node(type: string, id: string) {
  return `${type}:${id}`
}
