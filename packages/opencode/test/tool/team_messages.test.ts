import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { Team } from "@/team/team"
import { TeamGetMessagesTool } from "@/tool/team_get_messages"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelID, ProviderID } from "@/provider/schema"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

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

const seed = Effect.fn("TeamMessagesTest.seed")(function* () {
  const sessions = yield* Session.Service
  const team = yield* Team.Service
  const lead = yield* sessions.create({ title: "Lead" })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: lead.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: lead.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  const info = yield* team.create({ name: "messages-team", goal: "Coordinate work", leadSessionID: lead.id })
  const worker = yield* sessions.create({ parentID: lead.id, title: "Worker" })
  const member = yield* team.addMember({
    teamID: info.id,
    sessionID: worker.id,
    name: "worker",
    agentType: "general",
    rolePrompt: "Do the work",
  })
  yield* team.updateMemberStatus(member.id, "active")
  return { lead, user, assistant, info, member }
})

function context(input: {
  lead: Session.Info
  assistant: MessageV2.Assistant
  callID?: string
  messages?: MessageV2.WithParts[]
}) {
  return {
    sessionID: input.lead.id,
    messageID: input.assistant.id,
    callID: input.callID,
    agent: "build",
    abort: new AbortController().signal,
    messages: input.messages ?? [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const previousEmptyCheck = (input: { lead: Session.Info; assistant: MessageV2.Assistant }) =>
  Session.Service.use((sessions) =>
    sessions.updatePart({
      id: PartID.ascending(),
      messageID: input.assistant.id,
      sessionID: input.lead.id,
      type: "tool",
      callID: "previous-empty-check",
      tool: "team_get_messages",
      state: {
        status: "completed",
        input: {},
        output: "No pending messages.",
        title: "Team Messages",
        metadata: { count: 0 },
        time: { start: Date.now(), end: Date.now() },
      },
    }),
  )

describe("tool.team_get_messages", () => {
  it.live("tells the lead to end the turn when the mailbox is empty", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { lead, assistant } = yield* seed()
          const tool = yield* TeamGetMessagesTool
          const def = yield* tool.init()

          const result = yield* def.execute({}, context({ lead, assistant, callID: "current-check" }))

          expect(result.title).toBe("Team Messages")
          expect(result.output).toContain("No pending messages.")
          expect(result.output).toContain("end this turn instead of polling")
          expect(result.output).toContain("worker (general, active, session")
          expect(result.metadata.count).toBe(0)
          expect(result.metadata.repeated).toBe(false)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("blocks repeated empty mailbox polling in the same user turn", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const { lead, user, assistant } = yield* seed()
          yield* previousEmptyCheck({ lead, assistant })
          const currentAssistant: MessageV2.Assistant = {
            ...assistant,
            id: MessageID.ascending(),
            parentID: user.id,
            time: { created: Date.now() },
          }
          yield* sessions.updateMessage(currentAssistant)
          const tool = yield* TeamGetMessagesTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {},
            context({
              lead,
              assistant: currentAssistant,
              callID: "current-check",
              messages: yield* sessions.messages({ sessionID: lead.id }),
            }),
          )

          expect(result.title).toBe("Team Messages (Polling Blocked)")
          expect(result.output).toContain("Repeated empty mailbox check suppressed")
          expect(result.output).toContain("Do not send routine status-check broadcasts")
          expect(result.metadata.count).toBe(0)
          expect(result.metadata.repeated).toBe(true)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("still delivers new messages after a previous empty check", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { lead, assistant, info, member } = yield* seed()
          yield* previousEmptyCheck({ lead, assistant })
          yield* team.sendMessage({
            teamID: info.id,
            sender: member.session_id,
            recipients: [lead.id],
            body: "Implementation is complete.",
          })
          const tool = yield* TeamGetMessagesTool
          const def = yield* tool.init()

          const result = yield* def.execute({}, context({ lead, assistant, callID: "current-check" }))

          expect(result.title).toBe("Team Messages")
          expect(result.output).toContain("Implementation is complete.")
          expect(result.metadata.count).toBe(1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})
