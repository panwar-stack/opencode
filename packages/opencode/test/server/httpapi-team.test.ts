import { afterEach, describe, expect } from "bun:test"
import { Team } from "@/team/team"
import { Effect } from "effect"
import { Server } from "../../src/server/server"
import { TeamPaths } from "../../src/server/routes/instance/httpapi/groups/team"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Team.defaultLayer)

function request(path: string, init?: RequestInit) {
  return Effect.promise(async () => await Server.Default().app.request(path, init))
}

function responseJson(response: Response) {
  return Effect.promise(() => response.json())
}

afterEach(async () => {
  await resetDatabase()
})

describe("team HttpApi", () => {
  it.instance("returns team evaluation reports", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({ name: "http-eval", goal: "Expose eval", leadSessionID: "ses_http_eval_lead" })
      const member = yield* team.addMember({
        teamID: info.id,
        sessionID: "ses_http_eval_member",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      yield* team.updateMemberStatus(member.id, "completed", "done")
      yield* team.createUsageEvent({ teamID: info.id, type: "report_generated" })

      const response = yield* request(`${TeamPaths.root}/${info.id}/eval`, {
        headers: { "x-opencode-directory": test.directory },
      })
      const body = yield* responseJson(response)

      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(body).toMatchObject({
        team_id: info.id,
        nodes: expect.arrayContaining([expect.objectContaining({ id: `team:${info.id}`, type: "team" })]),
        edges: expect.arrayContaining([
          expect.objectContaining({
            type: "lead_to_member",
            from: `team:${info.id}`,
            to: `member:${member.session_id}`,
          }),
          expect.objectContaining({
            type: "produces",
            from: `member:${member.session_id}`,
            to: `result:${member.session_id}`,
          }),
        ]),
        summary: expect.objectContaining({
          root_cause_count: 0,
          usage: expect.objectContaining({
            member_count: 1,
            task_count: 0,
            final_report_generated: true,
          }),
        }),
      })
    }),
  )
})
