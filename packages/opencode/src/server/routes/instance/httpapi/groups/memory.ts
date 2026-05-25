import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { ApiNotFoundError, InvalidRequestError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const Strength = Schema.Literals(["strong", "weak"])

const JobInfo = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  title: Schema.optional(Schema.String),
  status: Schema.Literals(["running", "completed", "error", "cancelled"]),
  started_at: NonNegativeInt,
  completed_at: Schema.optional(NonNegativeInt),
  output: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "MemoryBackgroundJob" })

const StatusResponse = Schema.Struct({
  repository: Schema.String,
  indexed: Schema.Boolean,
  commits: NonNegativeInt,
  file_activity: NonNegativeInt,
  summaries: NonNegativeInt,
}).annotate({ identifier: "MemoryStatusResponse" })

const IndexPayload = Schema.Struct({
  max_commits: Schema.optional(NonNegativeInt),
  since: Schema.optional(Schema.String),
  base_commit: Schema.optional(Schema.String),
  cutoff_time: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  no_github: Schema.optional(Schema.Boolean),
  summaries: Schema.optional(NonNegativeInt),
}).annotate({ identifier: "MemoryIndexRequest" })

const IndexResponse = Schema.Struct({
  job: JobInfo,
}).annotate({ identifier: "MemoryIndexResponse" })

const SearchPayload = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(NonNegativeInt),
}).annotate({ identifier: "MemorySearchRequest" })

const SearchCommitItem = Schema.Struct({
  hash: Schema.String,
  message: Schema.String,
  changed_files: Schema.Array(Schema.String),
  score: Schema.Number,
  strength: Strength,
  issue_title: Schema.optional(Schema.String),
}).annotate({ identifier: "MemoryCommitSearchItem" })

const SearchCommitResponse = Schema.Struct({
  repository: Schema.String,
  commits: Schema.Array(SearchCommitItem),
}).annotate({ identifier: "MemoryCommitSearchResponse" })

const CommitParams = Schema.Struct({
  hash: Schema.String,
})

const CommitQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  max_diff_bytes: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

const CommitResponse = Schema.Struct({
  repository: Schema.String,
  hash: Schema.String,
  message: Schema.String,
  changed_files: Schema.Array(Schema.String),
  diff: Schema.String,
  truncated: Schema.Boolean,
  issue_number: Schema.optional(NonNegativeInt),
  issue_title: Schema.optional(Schema.String),
  issue_body: Schema.optional(Schema.String),
  warning: Schema.String,
}).annotate({ identifier: "MemoryCommitResponse" })

const SearchSummaryItem = Schema.Struct({
  path: Schema.String,
  summary: Schema.String,
  important_symbols: Schema.Array(Schema.String),
  source_hash: Schema.String,
  model_id: Schema.optional(Schema.String),
  score: Schema.Number,
  strength: Strength,
}).annotate({ identifier: "MemorySummarySearchItem" })

const SearchSummaryResponse = Schema.Struct({
  repository: Schema.String,
  summaries: Schema.Array(SearchSummaryItem),
}).annotate({ identifier: "MemorySummarySearchResponse" })

const SummaryQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String,
})

const SummaryResponse = Schema.Struct({
  repository: Schema.String,
  path: Schema.String,
  summary: Schema.String,
  important_symbols: Schema.Array(Schema.String),
  source_hash: Schema.String,
  current_source_hash: Schema.optional(Schema.String),
  model_id: Schema.optional(Schema.String),
  time_generated: NonNegativeInt,
  stale: Schema.Boolean,
  missing: Schema.Boolean,
}).annotate({ identifier: "MemorySummaryResponse" })

const ClearResponse = Schema.Struct({
  repository: Schema.String,
  cleared: Schema.Boolean,
}).annotate({ identifier: "MemoryClearResponse" })

export const MemoryPaths = {
  index: "/memory/index",
  status: "/memory/status",
  searchCommit: "/memory/search/commit",
  commit: "/memory/commit/:hash",
  searchSummary: "/memory/search/summary",
  summary: "/memory/summary",
  clear: "/memory",
} as const

export const MemoryApi = HttpApi.make("memory")
  .add(
    HttpApiGroup.make("memory")
      .add(
        HttpApiEndpoint.post("index", MemoryPaths.index, {
          query: WorkspaceRoutingQuery,
          payload: Schema.UndefinedOr(IndexPayload),
          success: described(IndexResponse, "Memory indexing job"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.index",
            summary: "Index repository memory",
            description: "Start a background job to index local repository commits and file summaries.",
          }),
        ),
        HttpApiEndpoint.get("status", MemoryPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(StatusResponse, "Repository memory status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.status",
            summary: "Get repository memory status",
            description: "Return commit, file activity, and summary counts for the active repository memory index.",
          }),
        ),
        HttpApiEndpoint.post("searchCommit", MemoryPaths.searchCommit, {
          query: WorkspaceRoutingQuery,
          payload: SearchPayload,
          success: described(SearchCommitResponse, "Commit memory search results"),
          error: ApiNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.searchCommit",
            summary: "Search commit memory",
            description: "Search repository commit memory for historical localization hints.",
          }),
        ),
        HttpApiEndpoint.get("commit", MemoryPaths.commit, {
          params: CommitParams,
          query: CommitQuery,
          success: described(CommitResponse, "Commit memory record"),
          error: [ApiNotFoundError, InvalidRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.commit",
            summary: "Examine commit memory",
            description: "Inspect a historical commit memory record. Old diffs must be verified against current source before editing.",
          }),
        ),
        HttpApiEndpoint.post("searchSummary", MemoryPaths.searchSummary, {
          query: WorkspaceRoutingQuery,
          payload: SearchPayload,
          success: described(SearchSummaryResponse, "File summary search results"),
          error: ApiNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.searchSummary",
            summary: "Search file summary memory",
            description: "Search cached high-activity file summaries for historical localization hints.",
          }),
        ),
        HttpApiEndpoint.get("summary", MemoryPaths.summary, {
          query: SummaryQuery,
          success: described(SummaryResponse, "File summary memory record"),
          error: ApiNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.summary",
            summary: "View file summary memory",
            description: "Show the cached repository-memory summary for a known file path.",
          }),
        ),
        HttpApiEndpoint.delete("clear", MemoryPaths.clear, {
          query: WorkspaceRoutingQuery,
          success: described(ClearResponse, "Repository memory clear result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.clear",
            summary: "Clear repository memory",
            description: "Clear repository memory for the active repository.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "memory", description: "Repository memory HttpApi routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )

export type IndexPayload = typeof IndexPayload.Type
export type SearchPayload = typeof SearchPayload.Type
export type CommitParams = typeof CommitParams.Type
export type CommitQuery = typeof CommitQuery.Type
export type SummaryQuery = typeof SummaryQuery.Type
