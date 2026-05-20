import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { collectExportSession } from "@/cli/cmd/tui/util/session-export"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { testEffect } from "../../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

const model = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test"),
}

const addUserMessage = (input: { sessionID: Session.Info["id"]; text: string }) =>
  Session.Service.use((sessions) =>
    Effect.gen(function* () {
      const message = yield* sessions.updateMessage<MessageV2.User>({
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model,
      })
      yield* sessions.updatePart<MessageV2.TextPart>({
        id: PartID.ascending(),
        sessionID: input.sessionID,
        messageID: message.id,
        type: "text",
        text: input.text,
      })
      return message
    }),
  )

const setCreated = (session: Session.Info, created: number) =>
  Effect.sync(() =>
    Database.use((db) =>
      db.update(SessionTable).set({ time_created: created }).where(eq(SessionTable.id, session.id)).run(),
    ),
  )

describe("tui session export collection", () => {
  it.instance("collects root messages, child sessions, nested children, and empty messages", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root" })
      const child = yield* sessions.create({ parentID: root.id, title: "Child" })
      const nested = yield* sessions.create({ parentID: child.id, title: "Nested" })
      const empty = yield* sessions.create({ parentID: root.id, title: "Empty" })
      yield* setCreated(child, 1)
      yield* setCreated(empty, 2)
      yield* addUserMessage({ sessionID: root.id, text: "root message" })
      yield* addUserMessage({ sessionID: child.id, text: "child message" })
      yield* addUserMessage({ sessionID: nested.id, text: "nested message" })

      const exported = yield* collectExportSession(root.id)

      expect(exported.info.id).toBe(root.id)
      expect(exported.messages.map((message) => message.info.id)).toHaveLength(1)
      expect(exported.messages[0]?.parts).toMatchObject([{ type: "text", text: "root message" }])
      expect(exported.children.map((node) => node.info.id)).toEqual([child.id, empty.id])
      expect(exported.children[0]?.messages[0]?.parts).toMatchObject([{ type: "text", text: "child message" }])
      expect(exported.children[0]?.children.map((node) => node.info.id)).toEqual([nested.id])
      expect(exported.children[0]?.children[0]?.messages[0]?.parts).toMatchObject([
        { type: "text", text: "nested message" },
      ])
      expect(exported.children[1]?.messages).toEqual([])
    }),
  )

  it.instance("orders siblings by created time then id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root" })
      const later = yield* sessions.create({ parentID: root.id, title: "Later" })
      const sameTimeB = yield* sessions.create({ parentID: root.id, title: "Same B" })
      const sameTimeA = yield* sessions.create({ parentID: root.id, title: "Same A" })
      yield* setCreated(later, 20)
      yield* setCreated(sameTimeB, 10)
      yield* setCreated(sameTimeA, 10)

      const exported = yield* collectExportSession(root.id)

      expect(exported.children.map((node) => node.info.id)).toEqual(
        [sameTimeB.id, sameTimeA.id].toSorted((a, b) => a.localeCompare(b)).concat(later.id),
      )
    }),
  )
})
