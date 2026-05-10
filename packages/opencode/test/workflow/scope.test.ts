import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { tmpdir } from "../fixture/fixture"
import { WorkflowScope, type SpecContent, type ScopeClassification } from "../../src/workflow/scope"
import { WorkflowArtifact } from "../../src/workflow/artifact"

const runScope = <A, E>(effect: Effect.Effect<A, E, WorkflowScope.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(WorkflowScope.defaultLayer)))

describe("WorkflowScope", () => {
  test("allows edits within allowed paths", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(
      path.join(tmp.path, ".opencode", "workflows", "wf_test", "IMPACT.md"),
      "# Impact\n\n## Allowed Paths\n\n- src/**\n- packages/opencode/src/**\n",
      { createPath: true },
    )

    const result = await runScope(
      WorkflowScope.Service.use((svc) => svc.checkEdit(tmp.path, "wf_test", ["src/index.ts", "packages/opencode/src/main.ts"])),
    )

    expect(result.allowed).toBe(true)
    expect(result.reason).toContain("within the approved impact boundary")
  })

  test("detects edits outside allowed paths", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(
      path.join(tmp.path, ".opencode", "workflows", "wf_test", "IMPACT.md"),
      "# Impact\n\n## Allowed Paths\n\n- src/**\n",
      { createPath: true },
    )

    const result = await runScope(
      WorkflowScope.Service.use((svc) => svc.checkEdit(tmp.path, "wf_test", ["src/index.ts", "secret/config.ts"])),
    )

    expect(result.allowed).toBe(false)
    expect(result.needs_amendment).toBe(true)
    expect(result.offending_files).toContain("secret/config.ts")
  })

  test("detects forbidden path edits", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(
      path.join(tmp.path, ".opencode", "workflows", "wf_test", "IMPACT.md"),
      "# Impact\n\n## Allowed Paths\n\n- src/**\n\n## Forbidden Paths\n\n- .env\n- secrets/\n",
      { createPath: true },
    )

    const result = await runScope(
      WorkflowScope.Service.use((svc) => svc.checkEdit(tmp.path, "wf_test", [".env"])),
    )

    expect(result.allowed).toBe(false)
    expect(result.offending_files).toContain(".env")
    expect(result.needs_amendment).toBe(false)
  })

  test("blocks new files when new_files_allowed is false", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(
      path.join(tmp.path, ".opencode", "workflows", "wf_test", "IMPACT.md"),
      "# Impact\n\n## Allowed Paths\n\n- src/**\n\n## Scope Rules\n\nnew files not allowed\n",
      { createPath: true },
    )

    const result = await runScope(
      WorkflowScope.Service.use((svc) =>
        svc.checkEdit(tmp.path, "wf_test", ["new_folder/novel.ts"], ["src/old.ts"]),
      ),
    )

    expect(result.allowed).toBe(false)
    expect(result.needs_amendment).toBe(true)
    expect(result.offending_files).toContain("new_folder/novel.ts")
  })

  test("allows new files under allowed directory when new_files_allowed is true", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(
      path.join(tmp.path, ".opencode", "workflows", "wf_test", "IMPACT.md"),
      "# Impact\n\n## Allowed Paths\n\n- src/**\n\n## Scope Rules\n\nnew files allowed\n",
      { createPath: true },
    )

    const result = await runScope(
      WorkflowScope.Service.use((svc) =>
        svc.checkEdit(tmp.path, "wf_test", ["src/novel.ts"], ["src/old.ts"]),
      ),
    )

    expect(result.allowed).toBe(true)
  })

  test("classifies in-scope comment", async () => {
    const spec: SpecContent = {
      summary: "Add password reset",
      requirements: ["password reset email", "rate limiting"],
      out_of_scope: ["UI changes"],
    }

    const comment = {
      id: "c1",
      body: "Please add rate limiting to the password reset endpoint.",
      state: "open" as const,
      source: "review_comment" as const,
    }

    const result = await runScope(
      WorkflowScope.Service.use((svc) => svc.checkComment(comment, spec)),
    )

    expect(result.tag).toBe("in_scope")
    if (result.tag === "in_scope") {
      expect(result.task).toBe("rate limiting")
    }
  })

  test("classifies out-of-scope comment", async () => {
    const spec: SpecContent = {
      summary: "Add password reset",
      requirements: ["password reset email"],
      out_of_scope: ["UI changes"],
    }

    const comment = {
      id: "c2",
      body: "Can you also redesign the login page UI?",
      state: "open" as const,
      source: "review_comment" as const,
    }

    const result = await runScope(
      WorkflowScope.Service.use((svc) => svc.checkComment(comment, spec)),
    )

    expect(result.tag).toBe("out_of_scope")
    if (result.tag === "out_of_scope") {
      expect(result.reason).toContain("UI changes")
    }
  })

  test("classifies clarification comment", async () => {
    const spec: SpecContent = {
      summary: "Add password reset",
      requirements: ["password reset email"],
      out_of_scope: [],
    }

    const comment = {
      id: "c3",
      body: "How should we handle expired reset tokens?",
      state: "open" as const,
      source: "review_comment" as const,
    }

    const result = await runScope(
      WorkflowScope.Service.use((svc) => svc.checkComment(comment, spec)),
    )

    expect(result.tag).toBe("clarification")
    if (result.tag === "clarification") {
      expect(result.question).toContain("clarification")
    }
  })

  test("parses spec content from markdown", async () => {
    const spec = `# Password Reset

## Summary

Add password reset functionality to the authentication system.

## Requirements

- Implement password reset email flow
- Add rate limiting to reset endpoint
- Validate reset tokens

## Out of Scope

- UI changes to login page
- Multi-factor authentication
`

    const result = await runScope(
      WorkflowScope.Service.use((svc) => svc.parseSpecContent(spec)),
    )

    expect(result.summary).toContain("password reset")
    expect(result.requirements).toHaveLength(3)
    expect(result.requirements).toContain("Implement password reset email flow")
    expect(result.out_of_scope).toContain("UI changes to login page")
  })
})
