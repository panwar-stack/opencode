import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { EOL } from "os"
import { formatQueryJSON, formatQueryText, toQueryInput } from "@/cli/cmd/memory"
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
