import { describe, expect, test } from "bun:test"
import { Memory } from "../../src/memory/memory"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ProviderTest } from "../fake/provider"

const openaiModel = ProviderTest.model({
  id: ModelID.make("gpt-5"),
  providerID: ProviderID.make("openai"),
  api: { id: "gpt-5", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
})

describe("Memory default summary generator", () => {
  test("passes OpenAI OAuth instructions through providerOptions", () => {
    const request = Memory.defaultSummaryStreamRequest({
      language: {
        modelId: "gpt-5",
        provider: "openai",
        specificationVersion: "v3",
      } as Parameters<typeof Memory.defaultSummaryStreamRequest>[0]["language"],
      model: openaiModel,
      isOpenaiOauth: true,
      input: {
        path: "src/file.ts",
        edit_count: 1,
        co_changed_files: [],
        content: "export const symbol = true",
        source_hash: crypto.randomUUID(),
      },
    })

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
    expect("maxOutputTokens" in request).toBe(false)
    expect(request.messages?.some((message) => message.role === "system")).toBe(false)
  })
})
