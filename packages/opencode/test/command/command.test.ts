import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Command } from "../../src/command"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Command.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("command", () => {
  it.live("includes internal spec planning commands", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const command = yield* Command.Service
          const specPlanner = yield* command.get("spec-planner")
          if (!specPlanner) throw new Error("spec-planner command not found")

          expect(specPlanner.source).toBe("command")
          expect(specPlanner.description).toContain("concrete engineering specs")
          expect(yield* Effect.promise(() => Promise.resolve(specPlanner.template))).toContain("Requirements To Spec")

          const clarify = yield* command.get("clarify")
          if (!clarify) throw new Error("clarify command not found")

          expect(clarify.source).toBe("command")
          expect(clarify.description).toContain("Clarify underspecified requests")
          expect(yield* Effect.promise(() => Promise.resolve(clarify.template))).toContain("Clarify Request")
          expect(yield* Effect.promise(() => Promise.resolve(clarify.template))).toContain("/spec-planner")

          const implementSpecPr = yield* command.get("spec-implement")
          if (!implementSpecPr) throw new Error("spec-implement command not found")

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

  it.live("includes init_v2 without changing init", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const command = yield* Command.Service
          const init = yield* command.get("init")
          if (!init) throw new Error("init command not found")

          expect(init.source).toBe("command")
          expect(init.description).toBe("guided AGENTS.md setup")
          expect(init.hints).toEqual(["$ARGUMENTS"])
          expect(yield* Effect.promise(() => Promise.resolve(init.template))).toContain(
            "Create or update `AGENTS.md` for this repository.",
          )
          expect(yield* Effect.promise(() => Promise.resolve(init.template))).not.toContain("Think before coding")

          const initV2 = yield* command.get("init_v2")
          if (!initV2) throw new Error("init_v2 command not found")

          expect(initV2.source).toBe("command")
          expect(initV2.description).toBe("guided AGENTS.md setup with required engineering principles")
          expect(initV2.hints).toEqual(["$ARGUMENTS"])
          expect(yield* Effect.promise(() => Promise.resolve(initV2.template))).toContain(
            "Create or update `AGENTS.md` for this repository.",
          )
          expect(yield* Effect.promise(() => Promise.resolve(initV2.template))).toContain(
            "Think before coding - Don't assume.",
          )
          expect(yield* Effect.promise(() => Promise.resolve(initV2.template))).toContain(
            "Simplicity first - Minimum code that solves the problem.",
          )
          expect(yield* Effect.promise(() => Promise.resolve(initV2.template))).toContain(
            "Surgical changes - Touch only what you must.",
          )
          expect(yield* Effect.promise(() => Promise.resolve(initV2.template))).toContain(
            "Goal-driven execution - Define success criteria.",
          )
          expect(yield* Effect.promise(() => Promise.resolve(initV2.template))).toContain(dir)
        }),
      { git: true },
    ),
  )
})
