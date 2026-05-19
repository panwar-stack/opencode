import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MessageID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import type { TeamEvalReport } from "@/team/eval"
import { Team } from "@/team/team"
import { TeamReportTool } from "@/tool/team_report"
import type * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Team.defaultLayer,
    Truncate.defaultLayer,
  ),
)

describe("tool.team_report", () => {
  it.live("includes evaluation summary and metadata", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({
            name: "report-team",
            goal: "Evaluate report output",
            leadSessionID: lead.id,
          })
          const worker = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_report_cancelled_worker",
            name: "worker",
            agentType: "general",
            rolePrompt: "Do the work",
          })
          yield* team.updateMemberStatus(worker.id, "cancelled")

          const tool = yield* TeamReportTool
          const def = yield* tool.init()
          const result = yield* def.execute({ lead_session_id: lead.id }, context(lead.id))
          const evalReport = result.metadata.eval as TeamEvalReport

          expect(result.title).toBe("Team Report: report-team")
          expect(result.output).toContain("## Team throughput")
          expect(result.output).toContain("## Cost and latency")
          expect(result.output).toContain("## Evaluation")
          expect(result.output).toContain("- root causes: 1")
          expect(result.output).toContain("Top root-cause findings:")
          expect(result.output).toContain("error execution.cancelled_member")
          expect(result.metadata.team_id).toBe(info.id)
          expect(result.metadata.throughput).toEqual(expect.objectContaining({ member_count: 1 }))
          expect(evalReport.team_id).toBe(info.id)
          expect(evalReport.summary.root_cause_count).toBe(1)
          expect(evalReport.findings.some((finding) => finding.category === "execution.cancelled_member")).toBe(true)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("reports no root causes for healthy teams", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({
            name: "healthy-report-team",
            goal: "Evaluate healthy report",
            leadSessionID: lead.id,
          })
          const worker = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_report_healthy_worker",
            name: "worker",
            agentType: "general",
            rolePrompt: "Do the work",
          })
          yield* team.updateMemberStatus(worker.id, "completed", "work complete")

          const tool = yield* TeamReportTool
          const def = yield* tool.init()
          const result = yield* def.execute({ team_id: info.id }, context(lead.id))
          const evalReport = result.metadata.eval as TeamEvalReport

          expect(result.output).toContain("- root causes: 0")
          expect(result.output).toContain("- top root causes: none")
          expect(evalReport.summary.root_cause_count).toBe(0)
          expect(evalReport.nodes.some((node) => node.id === `team:${info.id}`)).toBe(true)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})

function context(sessionID: SessionID): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}
