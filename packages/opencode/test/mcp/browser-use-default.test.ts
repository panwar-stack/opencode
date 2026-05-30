import { expect, test } from "bun:test"
import { MCP } from "../../src/mcp/index"

test("default browser-use MCP command runs BrowserMCP", () => {
  expect(MCP.DEFAULT_BROWSER_USE_MCP.command).toEqual(["npx", "@browsermcp/mcp@latest"])
})
