export * as ConfigMemory from "./memory"

import { PositiveInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"

const ProviderGitHub = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable GitHub review memory retrieval",
  }),
  repo: Schema.optional(Schema.String).annotate({
    description: "GitHub repository to use for review memory, in owner/repo form",
  }),
  max_age_days: Schema.optional(PositiveInt).annotate({
    description: "Maximum age in days for GitHub review memory",
  }),
  include_authors: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "GitHub authors whose review memory should be included",
  }),
  exclude_authors: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "GitHub authors whose review memory should be excluded",
  }),
})

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable historical review memory prompt injection",
  }),
  limit: Schema.optional(PositiveInt).annotate({
    description: "Maximum historical review memory constraints to inject into prompts",
  }),
  providers: Schema.optional(
    Schema.Struct({
      github: Schema.optional(ProviderGitHub),
    }),
  ).annotate({ description: "Review memory provider configuration" }),
}).annotate({ identifier: "MemoryConfig" })

export type Info = Schema.Schema.Type<typeof Info>
