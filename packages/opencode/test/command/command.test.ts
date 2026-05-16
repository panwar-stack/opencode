import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Command } from "../../src/command"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Command.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("command", () => {
  it.live("exposes review memory built-in skill as a command", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const command = yield* Command.Service
          const item = yield* command.get("review-memory")
          if (!item) throw new Error("review-memory command not found")

          expect(item.source).toBe("skill")
          expect(item.description).toContain("historical review memory")
          expect(yield* Effect.promise(() => Promise.resolve(item.template))).toContain("opencode memory review")
        }),
      { git: true },
    ),
  )
})
