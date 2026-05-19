import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import { SystemPrompt } from "../../src/session/system"
import { testEffect } from "../lib/effect"
import type { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ProjectID } from "../../src/project/schema"
import { SessionID, SessionRootID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const model: Provider.Model = {
  id: ModelID.make("test-model"),
  providerID: ProviderID.make("test"),
  api: { id: "test-model", url: "", npm: "" },
  name: "Test Model",
  capabilities: {
    toolcall: true,
    attachment: false,
    reasoning: false,
    temperature: true,
    interleaved: false,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1000, output: 1000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "",
}

const it = testEffect(
  SystemPrompt.layer.pipe(
    Layer.provide(
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ),
  ),
)

describe("session.system", () => {
  it.instance("environment lists registered roots", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const prompt = yield* SystemPrompt.Service
      const secondary = `${test.directory}-docs`
      const env = yield* prompt.environment(model, [
        {
          id: SessionRootID.make("sesroot_primary"),
          sessionID: SessionID.make("ses_test"),
          directory: test.directory,
          worktree: test.directory,
          projectID: ProjectID.make("proj_primary"),
          created: 1,
          primary: true,
        },
        {
          id: SessionRootID.make("sesroot_secondary"),
          sessionID: SessionID.make("ses_test"),
          name: "docs",
          directory: secondary,
          worktree: secondary,
          projectID: ProjectID.make("proj_secondary"),
          created: 2,
          primary: false,
        },
      ])
      const output = env.join("\n")

      expect(output).toContain("Session roots:")
      expect(output).toContain(`${test.directory} (primary); workspace: ${test.directory}`)
      expect(output).toContain(`docs: ${secondary}; workspace: ${secondary}`)
      expect(output).toContain("Snapshot/revert coverage: primary root only")
    }),
  )

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )
})
