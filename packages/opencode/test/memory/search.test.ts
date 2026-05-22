import { describe, expect, test } from "bun:test"
import { rankDocuments, tokenize, tokenText, DEFAULT_LIMITS } from "@/memory/search"

describe("memory search", () => {
  test("tokenizer preserves identifiers and file paths while splitting parts", () => {
    const tokens = tokenize("Fix parseRepositoryReference in src/util/repository-cache.ts for issue #123 TypeError bun test")

    expect(tokens).toContain("parserepositoryreference")
    expect(tokens).toContain("parse")
    expect(tokens).toContain("repository")
    expect(tokens).toContain("reference")
    expect(tokens).toContain("src/util/repository-cache.ts")
    expect(tokens).toContain("util")
    expect(tokens).toContain("repository")
    expect(tokens).toContain("cache")
    expect(tokens).toContain("#123")
    expect(tokens).toContain("typeerror")
    expect(tokens).toContain("bun")
    expect(tokens).not.toContain("in")
    expect(tokens).not.toContain("for")
  })

  test("ranks sparse documents deterministically with strong exact signals", () => {
    const results = rankDocuments(
      "parseRepositoryReference src/util/repository.ts",
      [
        { id: "b", token_text: tokenText("unrelated config parser") },
        { id: "a", token_text: tokenText("parseRepositoryReference src/util/repository.ts repository identity") },
        { id: "c", token_text: tokenText("repository reference parsing src/util/other.ts") },
      ],
    )

    expect(DEFAULT_LIMITS).toEqual({ commits: 20, summaries: 5 })
    expect(results.map((item) => item.id)).toEqual(["a", "c"])
    expect(results[0].strength).toBe("strong")
    expect(results[0].exact_file_path_match).toBe(true)
    expect(results[0].exact_identifier_match).toBe(true)
    expect(results[0].matched_tokens.map((item) => item.token)).toContain("parserepositoryreference")
    expect(results[0].score).toBeGreaterThan(results[1].score)
  })
})
