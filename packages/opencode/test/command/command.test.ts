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

          const learn = yield* command.get("learn")
          if (!learn) throw new Error("learn command not found")

          expect(learn.source).toBe("command")
          expect(learn.description).toContain("non-obvious learnings")
          expect(learn.hints).toEqual(["$ARGUMENTS"])
          expect(yield* Effect.promise(() => Promise.resolve(learn.template))).toContain("AGENTS.md files can exist")
          expect(yield* Effect.promise(() => Promise.resolve(learn.template))).toContain("$ARGUMENTS")

          const teamReport = yield* command.get("team-report")
          if (!teamReport) throw new Error("team-report command not found")

          expect(teamReport.source).toBe("command")
          expect(teamReport.description).toBe("Run the team_report tool for the active lead session.")
          expect(yield* Effect.promise(() => Promise.resolve(teamReport.template))).toContain("team_report")
          expect(yield* Effect.promise(() => Promise.resolve(teamReport.template))).toContain("compare_session_ids")
        }),
      { git: true },
    ),
  )
})
