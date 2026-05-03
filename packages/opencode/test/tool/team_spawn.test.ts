import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { Team } from "@/team/team"
import { TeamSpawnTool } from "@/tool/team_spawn"
import type { TaskPromptOps } from "@/tool/task"
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

const seed = Effect.fn("TeamSpawnTest.seed")(function* () {
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
  const info = yield* team.create({ name: "test-team", goal: "Coordinate work", leadSessionID: lead.id })
  return { lead, assistant, info }
})

function reply(input: SessionPrompt.PromptInput, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function context(input: { lead: Session.Info; assistant: MessageV2.Assistant; promptOps?: TaskPromptOps }) {
  return {
    sessionID: input.lead.id,
    messageID: input.assistant.id,
    agent: "build",
    abort: new AbortController().signal,
    extra: input.promptOps ? { promptOps: input.promptOps } : undefined,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const waitUntil = Effect.fn("TeamSpawnTest.waitUntil")(function* (predicate: () => Effect.Effect<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (yield* predicate()) return
    yield* Effect.sleep("10 millis")
  }
  throw new Error("Timed out waiting for condition")
})

describe("tool.team_spawn", () => {
  it.live("does not create an inert teammate when prompt operations are unavailable", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const sessions = yield* Session.Service
          const { lead, assistant, info } = yield* seed()
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              name: "architect",
              agent_type: "general",
              role_prompt: "Design the architecture",
            },
            context({ lead, assistant }),
          )

          expect(result.title).toBe("Team Spawn Failed")
          expect(result.output).toContain("prompt operations are unavailable")
          expect(yield* team.getMembers(info.id)).toHaveLength(0)
          expect(yield* sessions.children(lead.id)).toHaveLength(0)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("starts blocked teammates when their dependency completes", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          let releaseArchitect = () => {}
          const architectReleased = new Promise<void>((resolve) => {
            releaseArchitect = resolve
          })
          const calls: SessionPrompt.PromptInput[] = []
          const promptOps: TaskPromptOps = {
            cancel() {},
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            loop: (input) => Effect.sync(() => reply({ sessionID: input.sessionID, parts: [] }, "looped")),
            prompt: (input) =>
              Effect.promise(async () => {
                const index = calls.length
                calls.push(input)
                if (index === 0) await architectReleased
                return reply(input, index === 0 ? "architecture ready" : "implementation done")
              }),
          }
          const team = yield* Team.Service
          const { lead, assistant, info } = yield* seed()
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          yield* def.execute(
            {
              name: "architect",
              agent_type: "general",
              role_prompt: "Design the architecture",
            },
            context({ lead, assistant, promptOps }),
          )
          yield* waitUntil(() => Effect.sync(() => calls.length === 1))
          const architectPrompt = calls[0]?.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")
          expect(architectPrompt).toContain("Proactive communication requirements:")
          expect(architectPrompt).toContain('team_send_message recipient "lead"')
          const pendingLeadAfterStart = yield* team.getPendingMessages(lead.id, info.id)
          expect(pendingLeadAfterStart.some((message) => message.body.includes("architect (general) started"))).toBe(
            true,
          )

          yield* def.execute(
            {
              name: "implementer",
              agent_type: "general",
              role_prompt: "Implement after architecture is ready",
              depends_on: ["architect"],
            },
            context({ lead, assistant, promptOps }),
          )

          const blocked = (yield* team.getMembers(info.id)).find((member) => member.name === "implementer")
          expect(blocked?.status).toBe("blocked")
          expect(calls).toHaveLength(1)
          const architect = (yield* team.getMembers(info.id)).find((member) => member.name === "architect")
          expect(architect).toBeDefined()
          const pendingArchitect = yield* team.getPendingMessages(architect?.session_id ?? "", info.id)
          expect(pendingArchitect.some((message) => message.body.includes("waiting on your work"))).toBe(true)

          releaseArchitect()
          yield* waitUntil(() =>
            Effect.gen(function* () {
              return (yield* team.getMembers(info.id)).some(
                (member) => member.name === "implementer" && member.status === "completed",
              )
            }),
          )

          expect(calls).toHaveLength(2)
          expect(calls[1]?.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")).toContain(
            "architecture ready",
          )
          const pendingLead = yield* team.getPendingMessages(lead.id, info.id)
          expect(pendingLead.some((message) => message.body.includes("implementation done"))).toBe(true)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})
