import { describe, expect, test } from "bun:test"
import { githubIssueIdentifier } from "../../src/cli/cmd/github"

describe("githubIssueIdentifier", () => {
  test("formats GitHub issue and pull request identifiers", () => {
    expect(githubIssueIdentifier({ owner: "opencode-ai", repo: "opencode", issueId: 5 })).toBe("github.com/opencode-ai/opencode#5")
  })

  test("omits repository-only events", () => {
    expect(githubIssueIdentifier({ owner: "opencode-ai", repo: "opencode" })).toBeUndefined()
  })
})
