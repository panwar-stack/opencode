import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Team } from "@/team/team"
import { TeamCreateTool } from "@/tool/team_create"
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

function context(sessionID: SessionID) {
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

describe("tool.team_create", () => {
  it.live("creates a team from a primary session", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const tool = yield* TeamCreateTool
          const def = yield* tool.init()

          const result = yield* def.execute({ name: "primary", goal: "Coordinate work" }, context(lead.id))

          expect(result.title).toBe("Team Created")
          expect(Option.isSome(yield* team.getActive(lead.id))).toBe(true)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects child sessions before creating a team", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const child = yield* sessions.create({ parentID: lead.id, title: "Subagent" })
          const tool = yield* TeamCreateTool
          const def = yield* tool.init()

          const result = yield* def.execute({ name: "nested", goal: "Nested work" }, context(child.id))

          expect(result.title).toBe("Team Create Failed")
          expect(result.output).toContain("Child sessions cannot create teams")
          expect(Option.isNone(yield* team.getActive(child.id))).toBe(true)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects teammate sessions before creating a team", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "primary", goal: "Coordinate work", leadSessionID: lead.id })
          const teammate = yield* sessions.create({ parentID: lead.id, title: "Teammate" })
          yield* team.addMember({
            teamID: info.id,
            sessionID: teammate.id,
            name: "teammate",
            agentType: "general",
            rolePrompt: "Work",
          })
          const tool = yield* TeamCreateTool
          const def = yield* tool.init()

          const result = yield* def.execute({ name: "nested", goal: "Nested work" }, context(teammate.id))

          expect(result.title).toBe("Team Create Failed")
          expect(result.output).toContain("Team members cannot create nested teams")
          expect(Option.isNone(yield* team.getActive(teammate.id))).toBe(true)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})
