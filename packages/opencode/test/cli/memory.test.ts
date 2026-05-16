import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { EOL } from "os"
import {
  formatGithubIndexText,
  formatQueryJSON,
  formatQueryText,
  formatReviewJSON,
  formatReviewText,
  parsePrReviewChanges,
  parseGithubIndexRepo,
  rankReviewResults,
  toGithubIndexInput,
  toQueryInput,
  toReviewQueryInput,
  validateGithubIndexArgs,
  validateReviewArgs,
} from "@/cli/cmd/memory"
import { Memory } from "@/memory"
import { testEffect } from "../lib/effect"

const entries: Memory.Entry[] = [
  {
    id: "auth-tests",
    title: "Auth test flake",
    body: "Wait for the login signal before asserting auth state.",
    file: "src/auth/login.ts",
  },
  {
    id: "session-ui",
    title: "Session list rendering",
    body: "Keep the table output compact for terminal review.",
    file: "src/session/list.ts",
  },
]

const it = testEffect(Memory.layer(entries))

describe("memory cli", () => {
  test("formats compact text results", () => {
    expect(
      formatQueryText([
        {
          id: "auth-tests",
          title: "Auth test flake",
          body: "Wait for the login signal before asserting auth state.",
          file: "src/auth/login.ts",
          score: 11,
        },
      ]),
    ).toBe(
      [
        "1. Auth test flake",
        "   file: src/auth/login.ts",
        "   score: 11",
        "   Wait for the login signal before asserting auth state.",
      ].join(EOL),
    )
  })

  test("formats empty text results", () => {
    expect(formatQueryText([])).toBe("No memories found.")
  })

  test("formats JSON results", () => {
    expect(
      JSON.parse(
        formatQueryJSON([
          {
            id: "session-ui",
            title: "Session list rendering",
            body: "Keep the table output compact for terminal review.",
            score: 2,
          },
        ]),
      ),
    ).toEqual([
      {
        id: "session-ui",
        title: "Session list rendering",
        body: "Keep the table output compact for terminal review.",
        score: 2,
      },
    ])
  })

  test("builds query input from command args", () => {
    expect(toQueryInput({ text: "auth", file: "src/auth/login.ts" })).toEqual({
      text: "auth",
      file: "src/auth/login.ts",
    })
    expect(toQueryInput({ text: "auth" })).toEqual({ text: "auth" })
  })

  test("builds GitHub index input from command args", () => {
    expect(toGithubIndexInput({ since: "2026-05-01", limit: 50 }, "opencode/opencode")).toEqual({
      repo: "opencode/opencode",
      since: "2026-05-01",
      limit: 50,
    })
  })

  test("validates GitHub index args", () => {
    expect(validateGithubIndexArgs({ since: "2026-05-01", limit: 1 })).toBeUndefined()
    expect(validateGithubIndexArgs({ since: "not-a-date" })).toBe("--since must be a valid date")
    expect(validateGithubIndexArgs({ limit: 0 })).toBe("--limit must be a positive integer")
    expect(validateGithubIndexArgs({ limit: 1.5 })).toBe("--limit must be a positive integer")
  })

  test("parses GitHub index repositories", () => {
    expect(parseGithubIndexRepo("opencode/opencode")).toBe("opencode/opencode")
    expect(parseGithubIndexRepo("https://github.com/opencode/opencode.git")).toBe("opencode/opencode")
    expect(parseGithubIndexRepo("gitlab.com/opencode/opencode")).toBeUndefined()
  })

  test("formats GitHub index result", () => {
    expect(
      formatGithubIndexText({
        provider: "github",
        repo: "opencode/opencode",
        fetched: 2,
        indexed: 1,
        cursor: "2026-05-02T00:00:00Z",
      }),
    ).toBe(
      [
        "Indexed 1 of 2 GitHub review comments for opencode/opencode.",
        "Checkpoint: 2026-05-02T00:00:00Z",
      ].join(EOL),
    )
  })

  test("validates review args", () => {
    expect(validateReviewArgs({ base: "dev", pr: 1 })).toBeUndefined()
    expect(validateReviewArgs({ base: "" })).toBe("--base must not be empty")
    expect(validateReviewArgs({ pr: 0 })).toBe("--pr must be a positive integer")
    expect(validateReviewArgs({ pr: 1.5 })).toBe("--pr must be a positive integer")
  })

  test("builds review query input from changed files", () => {
    expect(
      toReviewQueryInput({
        repo: "opencode/opencode",
        changes: [
          { file: "src/auth/login.ts", status: "modified" },
          { file: "README.md", status: "added" },
        ],
      }),
    ).toEqual({
      text: "src/auth/login.ts src/auth modified README.md . added",
      repo: "opencode/opencode",
      limit: 50,
    })
  })

  test("parses PR review changes with diff shape", () => {
    expect(
      parsePrReviewChanges(
        ["src/auth/login.ts\tmodified", "src/auth/new.ts\tadded", "src/auth/old.ts\tremoved"].join(EOL),
      ),
    ).toEqual([
      { file: "src/auth/login.ts", status: "modified" },
      { file: "src/auth/new.ts", status: "added" },
      { file: "src/auth/old.ts", status: "deleted" },
    ])
  })

  test("ranks review results by exact file then directory overlap", () => {
    expect(
      rankReviewResults(
        [
          {
            id: "general-high-score",
            title: "General guidance",
            body: "Review terminal output carefully.",
            file: "src/ui/table.ts",
            score: 99,
          },
          {
            id: "same-directory",
            title: "Auth handlers",
            body: "Keep modified auth handlers small.",
            file: "src/auth/logout.ts",
            score: 1,
          },
          {
            id: "exact-file",
            title: "Login signal",
            body: "Wait for the login signal before asserting auth state.",
            file: "src/auth/login.ts",
            score: 1,
          },
        ],
        [{ file: "src/auth/login.ts", status: "modified" }],
      ).map((result) => result.id),
    ).toEqual(["exact-file", "same-directory", "general-high-score"])
  })

  test("formats review checklist text", () => {
    expect(
      formatReviewText({
        repo: "opencode/opencode",
        base: "dev",
        changes: [{ file: "src/auth/login.ts", status: "modified" }],
        results: [
          {
            id: "auth-tests",
            title: "Auth test flake",
            body: "Wait for the login signal before asserting auth state.",
            files: ["src/auth/login.ts"],
            confidence: 0.75,
            citations: [
              { label: "PR #12 review comment", url: "https://github.com/opencode/opencode/pull/12#discussion_r1" },
            ],
            score: 11,
          },
        ],
      }),
    ).toBe(
      [
        "Review memory checklist for opencode/opencode",
        "Scope: diff against dev",
        "Changed files: 1",
        "",
        "1. [ ] Wait for the login signal before asserting auth state.",
        "   files: src/auth/login.ts",
        "   confidence: 0.75",
        "   citations: PR #12 review comment https://github.com/opencode/opencode/pull/12#discussion_r1",
      ].join(EOL),
    )
  })

  test("formats empty review checklist text", () => {
    expect(
      formatReviewText({
        base: "dev",
        changes: [{ file: "src/auth/login.ts", status: "modified" }],
        results: [],
      }),
    ).toBe(
      [
        "Review memory checklist for current repository",
        "Scope: diff against dev",
        "Changed files: 1",
        "",
        "No review memories found.",
      ].join(EOL),
    )
  })

  test("formats review JSON", () => {
    expect(
      JSON.parse(
        formatReviewJSON({
          repo: "opencode/opencode",
          pr: 42,
          changes: [{ file: "src/session/list.ts", status: "modified" }],
          results: [
            {
              id: "session-ui",
              title: "Session list rendering",
              body: "Keep the table output compact for terminal review.",
              file: "src/session/list.ts",
              score: 2,
            },
          ],
        }),
      ),
    ).toEqual({
      repo: "opencode/opencode",
      pr: 42,
      files: ["src/session/list.ts"],
      changes: [{ file: "src/session/list.ts", status: "modified" }],
      results: [
        {
          id: "session-ui",
          title: "Session list rendering",
          body: "Keep the table output compact for terminal review.",
          file: "src/session/list.ts",
          score: 2,
        },
      ],
    })
  })

  it.effect("queries deterministic in-memory entries", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service

      expect((yield* memory.query({ text: "auth" })).map((result) => result.id)).toEqual(["auth-tests"])
      expect((yield* memory.query({ text: "review", file: "src/auth/login.ts" })).map((result) => result.id)).toEqual(
        [],
      )
    }),
  )
})
