import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Memory } from "@/memory/memory"
import { RepositoryMemoryFileSummaryTable } from "@/memory/memory.sql"
import { tokenText } from "@/memory/search"
import { Permission } from "@/permission"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, SessionID } from "@/session/schema"
import {
  MemoryExamineCommitTool,
  MemorySearchCommitTool,
  MemorySearchSummaryTool,
  MemoryViewSummaryTool,
} from "@/tool/memory"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Database } from "@/storage/db"
import { TestConfig } from "../fixture/config"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { pathToFileURL } from "url"

const agentLayer = Layer.mock(Agent.Service, {
  get: () =>
    Effect.succeed({
      name: "build",
      mode: "primary" as const,
      permission: Permission.fromConfig({ "*": "allow" }),
      options: {},
    }),
})

const truncateLayer = Layer.succeed(
  Truncate.Service,
  Truncate.Service.of({
    cleanup: () => Effect.void,
    write: () => Effect.succeed("/tmp/opencode-memory-test-output"),
    limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 51200 }),
    output: (text) => Effect.succeed({ content: text, truncated: false }),
  }),
)

const it = testEffect(
  Layer.mergeAll(
    Memory.defaultLayer,
    agentLayer,
    truncateLayer,
    TestConfig.layer({ get: () => Effect.succeed({ memory: { search_commit_limit: 5, search_summary_limit: 3 } }) }),
  ),
)
const registryIt = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, Memory.defaultLayer))

describe("tool.memory", () => {
  registryIt.instance("does not expose memory tools to wildcard permissions when memory is disabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        agent: wildcardAgent(),
      })

      expect(tools.filter((tool) => tool.id.startsWith("memory_"))).toEqual([])
    }),
    { git: true },
  )

  registryIt.instance("does not expose memory tools until the active repository is indexed", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        agent: wildcardAgent(),
      })

      expect(tools.filter((tool) => tool.id.startsWith("memory_"))).toEqual([])
    }),
    { git: true, config: { memory: { enabled: true } } },
  )

  registryIt.instance("exposes memory tools when enabled and the active repository is indexed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const memory = yield* Memory.Service
      const repository = yield* memory.ensureRepository({ reference: pathToFileURL(test.directory).href })
      yield* memory.upsertCommits(repository.id, [
        {
          hash: "abc123",
          message: "Fix memory registry gating",
          author_time: Date.now(),
          changed_files: ["src/tool/registry.ts"],
          diff: "diff --git a/src/tool/registry.ts b/src/tool/registry.ts",
          token_text: tokenText("memory registry gating"),
        },
      ])
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        agent: wildcardAgent(),
      })

      expect(tools.map((tool) => tool.id)).toEqual(
        expect.arrayContaining(["memory_search_commit", "memory_examine_commit", "memory_search_summary", "memory_view_summary"]),
      )
    }),
    { git: true, config: { memory: { enabled: true } } },
  )

  it.live("searches commits and marks weak results cautiously", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const repository = yield* seedRepository("weak")
      yield* memory.upsertCommits(repository.id, [
        {
          hash: "abc123",
          message: "Update cache behavior",
          author_time: Date.now(),
          changed_files: ["src/cache.ts"],
          diff: "diff --git a/src/cache.ts b/src/cache.ts",
          token_text: tokenText("cache behavior"),
        },
      ])
      const tool = yield* Tool.init(yield* MemorySearchCommitTool)
      const output = yield* tool.execute({ queries: ["cache"], repository: repository.identity }, context())

      expect(output.output).toContain("abc123")
      expect(output.output).toContain("strong=false")
      expect(output.output).toContain("Weak matches only")
    }),
  )

  it.live("logs GitHub retrieval context for memory searches", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const repository = yield* seedRepository("retrieval-log")
      yield* memory.upsertCommits(repository.id, [
        {
          hash: "abc123",
          message: "Fix GitHub memory logging",
          author_time: Date.now(),
          changed_files: ["src/cli/cmd/github.ts"],
          diff: "diff --git a/src/cli/cmd/github.ts b/src/cli/cmd/github.ts",
          token_text: tokenText("github memory logging"),
        },
      ])
      const sessionID = SessionID.make("ses_memory_retrieval_log")
      Memory.setRetrievalContext({ sessionID, context: { issueIdentifier: "github.com/opencode-ai/opencode#5" } })
      const tool = yield* Tool.init(yield* MemorySearchCommitTool)
      yield* tool.execute({ queries: ["github logging"], repository: repository.identity }, context([], sessionID))
      Memory.clearRetrievalContext(sessionID)

      const log = Database.use((db) => db.select().from(memory.tables.retrievalLog).all()).find((row) => row.session_id === sessionID)
      expect(log?.session_id).toBe(sessionID)
      expect(log?.issue_identifier).toBe("github.com/opencode-ai/opencode#5")
      expect(log?.tool).toBe("memory_search_commit")
      expect(JSON.parse(log?.returned_items ?? "[]")).toEqual(["abc123"])
    }),
  )

  it.live("examines commits with historical diff truncation warning", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const repository = yield* seedRepository("examine")
      yield* memory.upsertCommits(repository.id, [
        {
          hash: "def456",
          message: "Fix parser regression",
          author_time: Date.now(),
          changed_files: ["src/parser.ts", "test/parser.test.ts"],
          diff: "diff --git a/src/parser.ts b/src/parser.ts\n" + "x".repeat(80),
          token_text: tokenText("parser regression"),
        },
      ])
      const tool = yield* Tool.init(yield* MemoryExamineCommitTool)
      const output = yield* tool.execute({ hash: "def", repository: repository.identity, max_diff_bytes: 12 }, context())

      expect(output.output).toContain("historical")
      expect(output.output).toContain("Old line numbers may not match current source")
      expect(output.output).toContain("truncated to 12 bytes")
      expect(output.output).toContain("Tests touched: test/parser.test.ts")
    }),
  )

  it.live("searches and views cached file summaries", () =>
    Effect.gen(function* () {
      const repository = yield* seedRepository("summary")
      Database.use((db) =>
        db
          .insert(RepositoryMemoryFileSummaryTable)
          .values({
            id: `${repository.id}-summary`,
            repository_id: repository.id,
            path: "src/auth/session.ts",
            source_hash: "source-hash",
            summary: "Handles auth session refresh and cookie validation",
            important_symbols: JSON.stringify(["refreshSession", "validateCookie"]),
            token_text: tokenText("src/auth/session.ts auth session refresh cookie validateCookie"),
            time_generated: Date.now(),
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          .run(),
      )
      const search = yield* Tool.init(yield* MemorySearchSummaryTool)
      const view = yield* Tool.init(yield* MemoryViewSummaryTool)
      const found = yield* search.execute({ query: "auth session", repository: repository.identity }, context())
      const shown = yield* view.execute({ path: "src/auth/session.ts", repository: repository.identity }, context())

      expect(found.output).toContain("src/auth/session.ts")
      expect(found.output).toContain("validateCookie")
      expect(shown.output).toContain("Status: current")
      expect(shown.output).toContain("Handles auth session refresh")
    }),
  )
})

function seedRepository(name: string) {
  return Effect.gen(function* () {
    const memory = yield* Memory.Service
    return yield* memory.ensureRepository({ reference: `github:opencode-ai/memory-${name}-${crypto.randomUUID()}` })
  })
}

function context(requests: unknown[] = [], sessionID = SessionID.make("ses_memory_test")): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        requests.push(request)
      }),
  }
}

function wildcardAgent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    permission: Permission.fromConfig({ "*": "allow" }),
    options: {},
  }
}
