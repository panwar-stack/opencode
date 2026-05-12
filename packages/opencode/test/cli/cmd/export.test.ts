import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { collect } from "@/cli/cmd/export"
import { Session } from "@/session/session"
import { testEffect } from "../../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("cli export", () => {
  it.instance("collects teammate and nested subagent sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const lead = yield* sessions.create({ title: "Lead" })
      const teammate = yield* sessions.create({ parentID: lead.id, title: "Teammate" })
      const teammateSubagent = yield* sessions.create({ parentID: teammate.id, title: "Teammate subagent" })
      const leadSubagent = yield* sessions.create({ parentID: lead.id, title: "Lead subagent" })

      const exported = yield* collect(sessions, lead.id)

      expect(exported.info.id).toBe(lead.id)
      expect(exported.children.map((child) => child.info.id)).toEqual([teammate.id, leadSubagent.id])
      expect(exported.children[0]?.children.map((child) => child.info.id)).toEqual([teammateSubagent.id])
      expect(exported.children[1]?.children).toEqual([])
    }),
  )
})
