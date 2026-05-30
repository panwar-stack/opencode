import { expect, test } from "bun:test"
import { MCP } from "../../src/mcp/index"
import path from "path"

test("default browser-use MCP command runs headed", () => {
  expect(path.basename(MCP.DEFAULT_BROWSER_USE_MCP.command[0])).toMatch(/^uvx(\.exe)?$/)
  expect(MCP.DEFAULT_BROWSER_USE_MCP.command.slice(1)).toEqual([
    "--from",
    "browser-use[cli]",
    "browser-use",
    "--mcp",
    "--headed",
  ])
})
