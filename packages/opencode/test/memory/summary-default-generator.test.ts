import { describe, expect, mock } from "bun:test"
import { Effect, Layer } from "effect"
import type { LanguageModelV3 } from "@ai-sdk/provider"

type StreamTextOptions = {
  readonly providerOptions?: unknown
  readonly messages: readonly { readonly role: string }[]
}

const streamText = mock((_options: StreamTextOptions) => ({
  fullStream: (async function* () {
    yield {
      type: "text-delta" as const,
      text: JSON.stringify({ summary: "summary", important_symbols: ["symbol"] }),
    }
  })(),
}))

void mock.module("ai", () => ({
  NoSuchModelError: class NoSuchModelError extends Error {},
  streamText,
}))

const { Auth } = await import("../../src/auth")
const { Memory } = await import("../../src/memory/memory")
const { ModelID, ProviderID } = await import("../../src/provider/schema")
const { ProviderTest } = await import("../fake/provider")
const { testEffect } = await import("../lib/effect")

const openaiModel = ProviderTest.model({
  id: ModelID.make("gpt-5"),
  providerID: ProviderID.make("openai"),
  api: { id: "gpt-5", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
})

const provider = ProviderTest.fake({
  model: openaiModel,
  getLanguage: () =>
    Effect.succeed({ modelId: "gpt-5", provider: "openai", specificationVersion: "v3" } as unknown as LanguageModelV3),
}).layer

const auth = Layer.mock(Auth.Service)({
  get: () =>
    Effect.succeed({
      type: "oauth" as const,
      refresh: "refresh",
      access: "access",
      expires: Date.now() + 60_000,
    }),
})

const it = testEffect(Layer.mergeAll(Memory.defaultLayer, provider, auth))

describe("Memory default summary generator", () => {
  it.live("passes OpenAI OAuth instructions through providerOptions", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const repository = yield* memory.ensureRepository({ reference: `file:///tmp/opencode-summary-${crypto.randomUUID()}` })
      yield* memory.upsertFileActivity(repository.id, [
        { path: "src/file.ts", edit_count: 1, co_changed_files: [] },
      ])

      const result = yield* memory.generateFileSummaries({
        repository_id: repository.id,
        worktree: "/unused",
        limit: 1,
        source: () =>
          Effect.succeed({
            content: "export const symbol = true",
            source_hash: crypto.randomUUID(),
          }),
      })

      expect(result.generated).toBe(1)
      expect(streamText).toHaveBeenCalledTimes(1)
      const request = streamText.mock.calls[0]?.[0]
      if (!request) throw new Error("summary generation did not call streamText")
      expect(request).toMatchObject({
        providerOptions: {
          openai: {
            instructions:
              "Summarize repository source files for retrieval. Return only JSON with keys summary and important_symbols.",
            store: false,
          },
        },
        messages: [{ role: "user" }],
      })
      expect(request.messages.some((message) => message.role === "system")).toBe(false)
    }),
  )
})
