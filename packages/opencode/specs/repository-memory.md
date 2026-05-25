# Repository Memory

## Goal

Add repository memory to opencode so agents can use recent repository history and high-activity file summaries to localize bugs before reading source. The first implementation should follow the paper's practical design: build sparse-searchable commit memory and file-summary memory, expose explicit retrieval tools, and require agents to verify every memory hint against the current working tree before editing.

This is a new subsystem, not a resurrection of the removed GitHub review-memory feature. It should reuse opencode's existing repository identity, SQLite storage, tool registry, CLI, and GitHub Action surfaces where they fit.

## Current State

- `packages/opencode/specs/remove-github-review-memory.md` documents that the previous GitHub review-memory system was removed, including `opencode memory`, `packages/opencode/src/memory/*`, `Config.memory`, prompt injection, and the built-in `review-memory` skill.
- `packages/opencode/migration/20260516073015_review_memory/migration.sql` is historical only. It created `memory_repository`, `memory_source_item`, `memory_constraint`, `memory_constraint_source`, `memory_citation`, and `memory_sync_checkpoint`.
- `packages/opencode/migration/20260522174649_remove_review_memory/migration.sql` drops the old `memory_*` tables. Do not edit either historical migration.
- `packages/opencode/src/cli/cmd/github.ts` fetches current GitHub issue and PR context for `opencode github run`, builds prompts with comments and reviews, and knows owner/repo metadata during GitHub Actions. It does not persist or retrieve long-lived repository memory.
- `packages/opencode/src/util/repository.ts` provides repository normalization helpers such as `parseRepositoryReference`, `parseRemoteRepositoryReference`, `parseGitHubRemote`, `repositoryCachePath`, `repositoryCacheIdentity`, and `sameRepositoryReference`.
- `packages/opencode/src/reference/repository-cache.ts` can clone and fetch remote repositories into the global repo cache. It stores no memory records.
- `packages/opencode/src/storage/db.ts` owns the SQLite client and applies migrations from `packages/opencode/migration`.
- `packages/opencode/src/storage/schema.sql.ts` exposes shared timestamp columns through `Timestamps`.
- `packages/opencode/src/tool/tool.ts` defines built-in tool shape through `Tool.define`.
- `packages/opencode/src/tool/registry.ts` registers built-in tools, plugin tools, and project-local tools from `.opencode/tool` and `.opencode/tools`.
- `packages/opencode/src/session/tools.ts` exposes `Tool.Def` instances to the model and executes plugin hooks around tool calls.
- `packages/opencode/src/session/prompt.ts` assembles system prompts and resolves session tools. Tests currently assert that old `Historical review memory` text is absent.
- `packages/opencode/src/config/config.ts` has no `memory` field. `packages/opencode/test/config/config.test.ts` currently protects that old memory config is rejected.
- `packages/opencode/src/index.ts` registers top-level CLI commands and does not register `MemoryCommand`.
- `packages/opencode/src/background/job.ts` provides in-memory background jobs that can support manual indexing work, but jobs are not persisted.

## Non-Negotiables

- Memory retrieval must form hypotheses only. Agent-facing instructions and tool descriptions must say that old diffs and summaries cannot be patched directly without current source verification.
- Do not reintroduce unconditional `Historical review memory` prompt injection. Prefer explicit tools plus a short prompt rule when memory is enabled.
- Do not depend on dense retrieval in the first pass. Use sparse BM25-style scoring with an identifier-aware tokenizer.
- Do not require GitHub credentials to index local commit history. Linked GitHub issue title/body is optional enrichment when a token and remote identity are available.
- Do not index future information during evaluation. The indexer must support a cutoff commit or cutoff timestamp so historical issue evaluation can restrict records to data available before the issue arrived.
- Do not edit historical migration folders. Add new Drizzle schema in `src/**/*.sql.ts` and generate a forward migration.
- Exclude generated files, vendored files, lock files, binary files, and mass-formatting commits by default.
- Limit old diff output from retrieval tools to avoid prompt blowups.
- Keep first-pass scope to repository-local memory: commit history, file activity, file summaries, sparse indexes, four tools, CLI indexing/search, and an evaluation harness. Leave cross-repository shared memory, vector indexes, and automatic self-learning from conversations for future work.

## Memory Model

Add a new memory module under `packages/opencode/src/memory/` with flat ESM exports and a self-reexport, following `packages/opencode/AGENTS.md` module rules.

Use normalized repository identity from `packages/opencode/src/util/repository.ts` where possible. Store provider and repo fields separately only when GitHub enrichment needs them.

Suggested Drizzle schema file:

- `packages/opencode/src/memory/memory.sql.ts`

Tables:

```ts
repository_memory_repository
  id text primary key
  identity text not null unique
  provider text
  owner text
  name text
  default_branch text
  base_commit text
  time_created integer not null
  time_updated integer not null

repository_memory_commit
  id text primary key
  repository_id text not null references repository_memory_repository.id
  hash text not null
  message text not null
  author_time integer not null
  branch text
  base_commit text
  changed_files text not null
  diff text not null
  issue_number integer
  issue_title text
  issue_body text
  token_text text not null
  time_created integer not null
  time_updated integer not null

repository_memory_file_activity
  id text primary key
  repository_id text not null references repository_memory_repository.id
  path text not null
  edit_count integer not null
  last_modified integer
  co_changed_files text not null
  time_created integer not null
  time_updated integer not null

repository_memory_file_summary
  id text primary key
  repository_id text not null references repository_memory_repository.id
  path text not null
  source_hash text not null
  summary text not null
  important_symbols text not null
  token_text text not null
  model_id text
  time_generated integer not null
  time_created integer not null
  time_updated integer not null

repository_memory_retrieval_log
  id text primary key
  repository_id text not null references repository_memory_repository.id
  session_id text
  issue_identifier text
  tool text not null
  query text not null
  returned_items text not null
  selected_items text
  final_files text
  outcome text
  time_created integer not null
  time_updated integer not null
```

Search storage:

- First pass stores searchable document text in `token_text` and computes BM25-style scores by scanning only the scoped repository corpus at query time.
- The bounded first-pass corpus is at most the configured commit window plus configured summaries, defaulting to 7000 commit documents and 200 summary documents.
- `token_text` must contain whitespace-separated normalized tokens with repeated terms preserved so query-time scoring can compute term frequency, document frequency, average document length, and document length without reading the full diff body.
- Do not scan unbounded history during retrieval. If an implementation supports larger corpora, add SQLite FTS5 or an explicit inverted-index/stat table before raising defaults.

Indexes:

- `repository_memory_commit_repository_id_hash_idx` on `repository_id`, `hash`.
- `repository_memory_commit_repository_id_author_time_idx` on `repository_id`, `author_time`.
- `repository_memory_file_activity_repository_id_path_idx` on `repository_id`, `path`.
- `repository_memory_file_summary_repository_id_path_idx` on `repository_id`, `path`.
- `repository_memory_retrieval_log_repository_id_session_id_idx` on `repository_id`, `session_id`.

Store JSON arrays as text for `changed_files`, `co_changed_files`, `important_symbols`, `returned_items`, `selected_items`, and `final_files` unless this repository already standardizes a JSON SQLite helper before implementation.

## Tokenization And Retrieval

Implement sparse retrieval first in `packages/opencode/src/memory/search.ts`.

Tokenizer requirements:

- Preserve the full original identifier token.
- Also split camelCase, PascalCase, snake_case, kebab-case, dotted module paths, and slash-separated file paths.
- Preserve full file paths and path segments.
- Preserve issue numbers, error names, exception names, command names, and code-like tokens.
- Lowercase normalized tokens.
- Remove very common English stop words, but do not remove technical words aggressively.

Scoring requirements:

- Use BM25-style sparse scoring over `repository_memory_commit.token_text` and `repository_memory_file_summary.token_text`.
- Compute BM25 from the scoped `token_text` corpus in the first pass. SQLite FTS5 is future work unless the implementation chooses to add it in PR 1 with tests and generated migration support.
- Default query limits: 20 commits for commit search and 5 summaries for summary search.
- Return scores and enough matched token detail for debugging tests, but do not expose internal tokenizer noise in normal agent output.
- Treat exact file path and exact identifier matches as strong signals.
- If all scores are weak, tools must say no strong memory match rather than returning misleading confidence.

## Indexing

Add a repository memory service in `packages/opencode/src/memory/memory.ts`.

Commit indexing behavior:

- Default to the previous 7000 commits when available.
- Support `--since`, `--max-commits`, `--base-commit`, and `--cutoff-time` options.
- Treat `--base-commit` and evaluation `cutoff_commit` as exclusive. Index only ancestors reachable from the selected branch before that commit, not the cutoff commit itself.
- Treat `--cutoff-time` as exclusive. Index only commits with author time before the cutoff time.
- When both cutoff commit and cutoff time are supplied, apply both restrictions.
- Store commit hash, message, timestamp, modified files, diff text, branch/base metadata, and optional linked issue title/body.
- Use local git history for commit data. Use GitHub API enrichment only when remote identity and credentials are available.
- Skip merge commits by default unless they include normal patch data useful for localization.
- Skip commits touching only excluded files.
- Skip mass-formatting commits by default using a changed-file threshold.

File activity behavior:

- Count edits per path from the same commit window used for commit memory.
- Store top co-changed files per path for later debugging and ranking.
- Exclude the same generated, vendored, lock, and binary paths as commit indexing.

File summary behavior:

- Default to summarizing the top 200 active files.
- Refresh a summary when `source_hash` changes.
- Generate summaries with the same provider/model resolution used by normal opencode sessions, defaulting to current config and agent defaults rather than adding a separate LLM client.
- In CLI indexing, fail the summary phase with a clear auth/model error when no usable provider is configured, but keep commit memory and file activity written.
- Tests must use a deterministic provider or service seam; do not snapshot live model output.
- Summary prompt must ask for responsibility, inputs/outputs, dependencies, common bug/change patterns, important symbols, and retrieval keywords.
- If no model is configured or summary generation fails, keep commit memory and file activity usable and report summaries as incomplete.

Default exclusions:

- `**/node_modules/**`
- `**/.git/**`
- `**/dist/**`
- `**/build/**`
- `**/coverage/**`
- `**/vendor/**`
- `**/*.lock`
- `**/bun.lock`
- generated SDK output unless explicitly included

## CLI Surface

Add `packages/opencode/src/cli/cmd/memory.ts` and register it in `packages/opencode/src/index.ts`.

Commands:

```sh
opencode memory index [--max-commits 7000] [--summaries 200] [--base-commit <hash>] [--cutoff-time <iso>] [--branch <name>] [--no-github]
opencode memory search commit <query> [--limit 20]
opencode memory search summary <query> [--limit 5]
opencode memory examine commit <hash> [--max-diff-bytes 50000]
opencode memory view summary <path>
opencode memory status
opencode memory clear [--repository <identity>]
opencode memory eval --issues <path> [--max-commits 7000] [--summaries 200]
```

CLI behavior:

- Commands must be instance/project aware where repository identity depends on the current worktree.
- `index` may run in a `BackgroundJob` when called from the server/tool path, but CLI should also support foreground output for deterministic tests.
- `clear` must require explicit repository scope when not running inside a project.
- Search commands should print stable, testable text with hashes, scores, messages, changed files, and paths.
- Evaluation input should be a JSON file of historical issues with issue identifier, query text, cutoff commit or time, and expected files.

## Tool Surface

Expose four built-in tools through `packages/opencode/src/tool/registry.ts`.

Tool ids should use opencode-style snake_case while descriptions can name the paper-style tool names:

```ts
memory_search_commit
  description: SearchCommit. Search repository commit memory for past changes related to one or more natural-language or code queries.
  parameters: { queries: string[]; limit?: number; repository?: string }
  output: ranked commits with hash, message, changed files, score, short issue title, and whether the match is strong.

memory_examine_commit
  description: ExamineCommit. Inspect a retrieved commit memory record.
  parameters: { hash: string; repository?: string; max_diff_bytes?: number }
  output: full or truncated diff, linked issue summary, changed files, tests touched, and warning that old line numbers are historical.

memory_search_summary
  description: SearchSummary. Search cached high-activity file summaries by behavior, subsystem, error, or function.
  parameters: { query: string; limit?: number; repository?: string }
  output: ranked file paths with summaries, important symbols, score, and whether the match is strong.

memory_view_summary
  description: ViewSummary. Show the cached repository-memory summary for a known file path.
  parameters: { path: string; repository?: string }
  output: cached summary, important symbols, source hash, generation time, and stale/missing status.
```

Tool permissions:

- Memory tools must not be exposed just because built-in agents have wildcard permissions. Gate them by config and index availability in `packages/opencode/src/tool/registry.ts`, or add explicit deny-by-default permission rules that override wildcard allow when memory is disabled.
- Read-only retrieval tools default to allowed for built-in agents only when `memory.enabled` is true and an index exists for the active repository.
- Indexing and clearing are CLI/API operations in the first pass, not model-callable tools.
- If an indexing tool is added later, default it to ask or deny.

Agent-facing guidance:

- Use memory early for issue-like tasks, stack traces, regressions, migrations, validation bugs, serialization bugs, authentication bugs, and database behavior.
- Search commits with two or three queries: likely old commit message, exact error text, and domain concept.
- Search summaries for the expected behavior or failing subsystem.
- Merge candidates from memory results, issue-mentioned files, and normal code search.
- Read current source before patching.
- Do not confuse old diff line numbers with current source line numbers.

## GitHub Integration

Use `packages/opencode/src/cli/cmd/github.ts` as the first GitHub integration point.

Behavior:

- During `opencode github run`, resolve the repository identity from the GitHub event and current remote.
- If memory is enabled and an index exists, make memory tools available and add a concise prompt rule telling the agent to use repository memory for localization hints, then verify with current source.
- Do not automatically dump retrieved memory into every prompt.
- For issue and PR events, pass issue/PR number and title into retrieval logs when available.
- Do not index GitHub data during every action run by default. Indexing must be explicit through CLI/API or a config option.

Linked issue enrichment:

- Parse issue references from commit messages and PR merge messages.
- Fetch issue title/body through GitHub API only when `GITHUB_TOKEN` or the existing GitHub Action auth path is available.
- Store missing linked issue text as empty fields, not as an indexing failure.

## Config

Add a minimal config module before agent tools are exposed. CLI indexing and CLI search can work before config exists, but session tools and prompt rules must remain unavailable until config gating is implemented.

Suggested shape:

```ts
memory?: {
  enabled?: boolean
  index_on_start?: boolean
  max_commits?: number
  summary_limit?: number
  search_commit_limit?: number
  search_summary_limit?: number
  include?: string[]
  exclude?: string[]
  github?: {
    enabled?: boolean
    fetch_linked_issues?: boolean
  }
}
```

Defaults:

- `enabled`: `false`. Running `opencode memory index` creates data but does not automatically expose agent tools unless config enables memory.
- `index_on_start`: `false`.
- `max_commits`: `7000`.
- `summary_limit`: `200`.
- `search_commit_limit`: `20`.
- `search_summary_limit`: `5`.
- `github.enabled`: `true` when a GitHub remote is detected.
- `github.fetch_linked_issues`: `true` only when credentials are available.

If `Config.Info` changes, update `/config` and `/global/config` OpenAPI output through the existing config API and regenerate the JS SDK.

## API Surface

Add HTTP API routes only after the CLI/service path is covered by tests.

Suggested files:

- `packages/opencode/src/server/routes/instance/httpapi/groups/memory.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/memory.ts`
- Register the group in `packages/opencode/src/server/routes/instance/httpapi/api.ts`.

Suggested endpoints:

```http
POST /memory/index
GET /memory/status
POST /memory/search/commit
GET /memory/commit/:hash
POST /memory/search/summary
GET /memory/summary?path=<file-path>
DELETE /memory
```

Use a query parameter for summary path lookup because file paths contain slashes and are awkward as path parameters.

SDK impact:

- Regenerate OpenAPI and the JS SDK when these endpoints or config types are added.
- Use `./packages/sdk/js/script/build.ts` from the repo root after the server schema changes.

## Evaluation Harness

Add an evaluation harness to test localization against closed historical issues.

Input JSON shape:

```json
[
  {
    "id": "issue-123",
    "query": "error text, reproduction, or issue body",
    "cutoff_commit": "abc123",
    "cutoff_time": "2026-01-01T00:00:00Z",
    "expected_files": ["src/example.ts"]
  }
]
```

Metrics:

- Accuracy at 1, 3, and 5 files.
- Final issue resolution rate when paired with agent runs, if available.
- Average memory tool calls.
- Indexing cost and summary generation cost.
- Retrieval latency.
- Percentage of runs where memory produced a false lead.

Evaluation rules:

- Use `cutoff_commit` or `cutoff_time` to prevent future leakage. `cutoff_commit` and `cutoff_time` are exclusive.
- Restrict commit traversal to ancestors reachable from the selected branch before the cutoff. Do not scan unrelated refs unless the evaluation input explicitly names them.
- Fetch linked GitHub issue text only when the issue was created before the cutoff and the issue body/comment data would have been visible at the cutoff. Otherwise leave linked issue fields empty.
- Exclude issue text that would not have been available at cutoff time.
- Report separate results for commit memory only, summary memory only, and combined memory.

## Implementation Slices

### PR 1: Storage, Repository Identity, And Sparse Search

- Add `packages/opencode/src/memory/memory.sql.ts` with new `repository_memory_*` tables and indexes.
- Add a memory service skeleton in `packages/opencode/src/memory/memory.ts` using repository identity helpers from `packages/opencode/src/util/repository.ts`.
- Add tokenizer and BM25-style scorer in `packages/opencode/src/memory/search.ts`.
- Wire `Memory.Service` into the relevant Effect runtime layer, including `packages/opencode/src/effect/app-runtime.ts`, so later CLI, tool, GitHub, and API paths share one service definition.
- Generate a forward migration named `repository_memory` from `packages/opencode`.
- Add focused tests for schema access, repository identity, tokenizer behavior, and sparse ranking.

Verification:

- `cd packages/opencode && bun run db generate --name repository_memory`
- `cd packages/opencode && bun test test/memory/search.test.ts test/memory/memory.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Confirm table and column names are snake_case, indexes follow the repo database guide, historical migrations are untouched, and tokenization preserves exact identifiers and file paths.

### PR 2: Commit And File Activity Indexing CLI

- Add `packages/opencode/src/cli/cmd/memory.ts` with `index`, `status`, `search commit`, `examine commit`, and `clear` subcommands.
- Register `MemoryCommand` in `packages/opencode/src/index.ts`.
- Implement local git commit crawling, diff capture, changed-file extraction, exclusions, mass-formatting skip logic, and cutoff options.
- Implement file activity counting and co-changed-file storage.
- Add optional linked GitHub issue enrichment without requiring credentials.
- Add CLI tests that use a temporary git repository and do not depend on network access.

Verification:

- `cd packages/opencode && bun test test/cli/memory.test.ts test/memory/index.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Confirm local indexing works offline, cutoff options prevent future leakage, excluded files are skipped, and `clear` cannot accidentally wipe unrelated repository memory.

### PR 3: File Summary Generation

- Add summary generation for the top active files from `repository_memory_file_activity`.
- Use the configured opencode model/provider rather than a new standalone LLM client.
- Store `source_hash`, `summary`, `important_symbols`, `model_id`, generated time, and summary tokens.
- Add `search summary` and `view summary` CLI subcommands.
- Make summary generation resumable: unchanged `source_hash` records are reused, failed files are reported without failing the whole index.
- Add tests for summary refresh decisions and CLI output using a deterministic test provider or local service seam.

Verification:

- `cd packages/opencode && bun test test/memory/summary.test.ts test/cli/memory.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Confirm summary prompts include responsibility, inputs/outputs, dependencies, common bug/change patterns, symbols, and retrieval keywords. Confirm failed summary generation does not break commit memory search.

### PR 4: Agent Tools And Prompt Rule

- Add `packages/opencode/src/config/memory.ts` and expose `memory?: ConfigMemory.Info` from `packages/opencode/src/config/config.ts` with `memory.enabled` defaulting to false.
- Add built-in tools `memory_search_commit`, `memory_examine_commit`, `memory_search_summary`, and `memory_view_summary`.
- Register the tools in `packages/opencode/src/tool/registry.ts` and expose them through `packages/opencode/src/session/tools.ts` only when `memory.enabled` is true and an index exists for the active repository.
- Add explicit tests proving disabled memory tools are absent or denied even when an agent has wildcard `*`: `allow` permissions.
- Add default read-only permissions in `packages/opencode/src/agent/agent.ts` only after config/index gating prevents accidental exposure.
- Add a concise memory workflow rule near prompt assembly in `packages/opencode/src/session/prompt.ts`, but do not inject retrieved memory content automatically.
- Add tests for config parsing, tool parameters, retrieval output truncation, weak-score behavior, and prompt text absence/presence.

Verification:

- `cd packages/opencode && bun test test/config/config.test.ts test/tool/memory.test.ts test/session/prompt.test.ts test/agent/agent.test.ts`
- `cd packages/opencode && bun typecheck`
- `./packages/sdk/js/script/build.ts`
- `cd packages/sdk/js && bun typecheck`

Review:

Confirm tools are read-only, disabled memory is not exposed through wildcard permissions, old diffs are clearly marked historical, weak retrieval results do not create false confidence, and prompt changes do not reintroduce the old `Historical review memory` block.

### PR 5: GitHub Action Retrieval Context

- In `packages/opencode/src/cli/cmd/github.ts`, pass GitHub issue/PR identifiers into retrieval logs and enable memory tools when configured and indexed.
- Keep indexing explicit; do not run full indexing during every GitHub Action invocation by default.

Verification:

- `cd packages/opencode && bun test test/cli/github.test.ts test/session/prompt.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Confirm GitHub runs can use existing memory without hidden indexing, config defaults keep memory opt-in, and generated SDK types expose only the new repository-memory config shape.

### PR 6: HTTP API And Evaluation Harness

- Add memory HTTP API group and handlers for status, indexing, commit search, commit examine, summary search, summary view, and clear.
- Use `packages/opencode/src/background/job.ts` for server-triggered indexing jobs.
- Wire API handlers through the same `Memory.Service` layer as CLI and tools.
- Add `opencode memory eval --issues <path>` using the evaluation JSON shape in this spec.
- Store retrieval logs from CLI, tools, GitHub runs, and API calls in `repository_memory_retrieval_log`.
- Regenerate OpenAPI and JS SDK output for new endpoints.

Verification:

- `cd packages/opencode && bun test test/server/memory.test.ts test/cli/memory.test.ts test/memory/eval.test.ts`
- `cd packages/opencode && bun typecheck`
- `./packages/sdk/js/script/build.ts`
- `cd packages/sdk/js && bun typecheck`

Review:

Confirm API requests match CLI behavior, background indexing reports stable status, evaluation enforces cutoff data, and SDK generation contains the new memory endpoints.

## Future Work

- Dense/vector retrieval after BM25 baselines are measured.
- Cross-repository memory sharing.
- Automatic incremental indexing on schedule or after GitHub events.
- Conversation-derived long-term memory.
- TUI screens for memory status, indexing progress, and evaluation reports.
- More advanced graph traversal that combines memory results with imports, call sites, references, and tests.

## Open Questions

- Should repository memory be opt-in until after evaluation? Default recommendation: yes. Keep `memory.enabled` false by default and make `opencode memory index` the explicit activation path.
- Should GitHub linked issue enrichment use direct GitHub API calls or the `gh` CLI? Default recommendation: use the existing GitHub HTTP/auth approach in `packages/opencode/src/cli/cmd/github.ts` where possible, and do not add a required `gh` dependency.
- Should summary generation be part of `opencode memory index` by default? Default recommendation: yes, but allow `--summaries 0` and continue successfully when model-backed summary generation is unavailable.
