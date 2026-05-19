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

  it.live("includes internal spec planning commands", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const command = yield* Command.Service
          const specPlanner = yield* command.get("spec-planner")
          if (!specPlanner) throw new Error("spec-planner command not found")

          expect(specPlanner.source).toBe("command")
          expect(specPlanner.description).toContain("concrete engineering specs")
          expect(yield* Effect.promise(() => Promise.resolve(specPlanner.template))).toContain(
            "Requirements To Spec",
          )

          const implementSpecPr = yield* command.get("implement-spec-pr")
          if (!implementSpecPr) throw new Error("implement-spec-pr command not found")

          expect(implementSpecPr.source).toBe("command")
          expect(implementSpecPr.description).toBe(
            "Understand a specification thoroughly and implement only the requested PR slice.",
          )
          expect(implementSpecPr.hints).toEqual(["$1", "$2"])
          expect(yield* Effect.promise(() => Promise.resolve(implementSpecPr.template))).toContain(
            "Implement only the work required for PR `#$2`.",
          )
        }),
      { git: true },
    ),
  )
})
