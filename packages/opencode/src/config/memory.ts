export * as ConfigMemory from "./memory"

import { NonNegativeInt, PositiveInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Expose repository memory tools and prompt guidance when an index exists (default: false)",
  }),
  index_on_start: Schema.optional(Schema.Boolean).annotate({
    description: "Index repository memory automatically when a project starts (default: false)",
  }),
  max_commits: Schema.optional(PositiveInt).annotate({ description: "Maximum commits to index (default: 7000)" }),
  summary_limit: Schema.optional(NonNegativeInt).annotate({ description: "Maximum file summaries to maintain (default: 200)" }),
  search_commit_limit: Schema.optional(PositiveInt).annotate({
    description: "Default limit for memory_search_commit (default: 20)",
  }),
  search_summary_limit: Schema.optional(PositiveInt).annotate({
    description: "Default limit for memory_search_summary (default: 5)",
  }),
  include: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Repository memory include globs",
  }),
  exclude: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Repository memory exclude globs",
  }),
  github: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean).annotate({
        description: "Enable GitHub metadata enrichment when available",
      }),
      fetch_linked_issues: Schema.optional(Schema.Boolean).annotate({
        description: "Fetch linked GitHub issues when credentials are available",
      }),
    }),
  ),
}).annotate({ identifier: "MemoryConfig" })
export type Info = Schema.Schema.Type<typeof Info>

export function enabled(config: Info | undefined) {
  return config?.enabled === true
}
