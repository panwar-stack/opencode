# Native Review Memory CLI

## Goal

Make the GitHub PR review memory proposal native to the opencode CLI without making the feature GitHub-only.

The first implementation should add a service-backed `opencode memory` capability that can index, query, and surface compact historical review constraints. GitHub PR review comments are the first built-in provider, but the CLI and service model must leave room for future providers such as ADRs, incident reports, design docs, issue trackers, Slack exports, or internal policy systems.

## Current State

- `specs/github-pr-review-memory.md` defines the desired product behavior: task-aware retrieval, compact constraints, citations, ranking, dedupe, conflict handling, and quiet automatic use.
- `src/index.ts` registers native yargs commands, including `GithubCommand` and `PrCommand`.
- `src/cli/cmd/github.ts` is GitHub Actions infrastructure. It handles `github install` and `github run`, uses workflow context, and should not become the local review-memory UX.
- `src/cli/cmd/pr.ts` implements `opencode pr <number>` as a checkout/TUI shortcut. It is not a good home for indexing, querying, or cache management.
- `src/command/index.ts` and `src/command/template/review.txt` define slash-command review behavior. This path is useful for later automatic review-memory surfacing, but it cannot own crawling, indexing, ranking, auth, or caching.
- `src/storage/db.ts` provides the SQLite database client and migration path used by persisted domain state.
- `src/storage/storage.ts` provides JSON blob storage under `Global.Path.data/storage`; this is useful for small non-queryable cache artifacts, not ranked review-memory search.
- `src/session/prompt.ts` is the main prompt assembly point and the best place to inject compact retrieved review constraints before model calls.
- `src/config/config.ts` owns the user/project config schema. There is no current memory provider config.

## Non-Negotiables

- Do not implement this as a GitHub-only CLI design. GitHub is the first provider behind a generic memory capability.
- Do not store review memory in session messages, compaction summaries, instruction files, or `AGENTS.md`.
- Do not inject raw PR comments into model context. Inject compact, cited, confidence-ranked constraints.
- Do not treat historical review feedback as more authoritative than explicit user instructions, current code, ADRs, or repo instructions.
- Keep indexing and retrieval deterministic in the first pass. Avoid requiring an LLM summarization step before the provider and cache behavior are stable.
- Keep privacy explicit: private PR comments cached locally need scoped storage, retention controls, and a clear disable path.
- Run tests from `packages/opencode`, never from repo root.

## CLI Surface

Add a new native command module:

```text
src/cli/cmd/memory.ts
```

Register it in `src/index.ts` near the existing GitHub and PR commands:

```ts
.command(MemoryCommand)
```

Use `src/cli/effect-cmd.ts` for command handlers so repo-scoped commands get `InstanceRef` and the normal Effect runtime setup.

Initial command shape:

```sh
opencode memory index github [--repo owner/repo] [--since <date>] [--limit <n>]
opencode memory query <text> [--file <path>] [--json]
opencode memory review [--base dev] [--pr <number>] [--json]
```

Behavior:

- `memory index github` fetches and indexes GitHub PR review comments and threads using local `gh` or existing GitHub credentials.
- `memory query` returns ranked historical constraints for a task string and optional file path.
- `memory review` retrieves memory relevant to the current diff, a base branch, or a PR number, then prints the constraints that should be checked before final response or PR creation.
- `--json` emits machine-readable output for tests, scripts, and future TUI/API consumers.

Avoid these placements:

- Do not put local review memory under `opencode github run`; that command is GitHub Actions/bot oriented.
- Do not put cache/index management under `opencode pr`; that command is currently checkout oriented.
- Do not make `/review` the only interface; slash commands can consume memory later, but the native capability needs its own CLI surface.

## Service Design

Add a generic service namespace under either `src/memory/` or `src/review-memory/`. Prefer `src/memory/` if the first PR can keep names generic without over-abstracting.

Suggested files:

```text
src/memory/index.ts
src/memory/provider.ts
src/memory/github.ts
src/memory/memory.sql.ts
```

Core provider shape:

```ts
type MemoryQuery = {
  text: string
  files?: string[]
  repo?: string
  limit?: number
}

type MemoryConstraint = {
  id: string
  provider: string
  repo: string
  text: string
  confidence: number
  citations: MemoryCitation[]
  files: string[]
  created_at: number
  updated_at: number
}

type MemoryCitation = {
  label: string
  url: string
}
```

Provider responsibilities:

- Fetch source data incrementally.
- Normalize comments and threads into queryable records.
- Deduplicate repeated feedback.
- Rank results by file path, directory, symbol, task intent, diff shape, labels, PR title, reviewer, recency, and repeated occurrence.
- Preserve citations back to original review comments or PRs.
- Return compact constraints to callers.

The GitHub provider should live behind the generic provider API. GitHub-specific logic should not leak into prompt assembly or command registration beyond the `memory index github` subcommand.

## Storage

Use SQLite via `src/storage/db.ts` for the local index.

Create schema in a dedicated SQL module, likely:

```text
src/memory/memory.sql.ts
```

Required data concepts:

- Repository identity: normalized provider and repo name, separate from local `ProjectID` because forks, renamed remotes, and alternate worktrees can share or diverge from a GitHub repo.
- Indexed source item: PR number, review thread/comment ID, author, URL, path, position or line metadata, labels, title, timestamps, and source update marker.
- Constraint: compact guidance text, confidence score, applicable files/directories/symbols, source item references, and stale/active status.
- Sync checkpoint: provider, repo, last fetched cursor or timestamp, and fetch options.

Use `Storage.Service` only for small non-queryable artifacts, such as optional raw fetch checkpoints. Do not use JSON blob storage for ranked retrieval.

Migration command when schema is added:

```sh
bun run db generate --name review_memory
```

## Prompt Integration

The CLI makes memory inspectable and controllable. The feature becomes native to opencode when retrieved memory can also be surfaced automatically during coding.

Integrate through `src/session/prompt.ts` after the memory service is stable:

- Retrieve task-level memory before the first assistant step when the user asks for code changes, bug fixes, feature work, or review work.
- Retrieve file-level memory when affected files are known.
- Retrieve diff-level memory before final response or PR creation.
- Inject only a compact block of constraints, not raw comments.
- Include citations without overwhelming the task context.
- Surface conflicts instead of silently choosing between stale and current guidance.

Prompt format should make authority clear:

```text
Historical review memory, advisory and lower priority than current user instructions, repo instructions, ADRs, and current code:
- Prefer Effect FileSystem over raw fs/promises in Effect services. Source: PR #123 comment ...
- Avoid adding config fields without schema tests. Source: PR #98 comment ...
```

## Config

Add config for policy and provider behavior, not memory contents.

Suggested module:

```text
src/config/memory.ts
```

Follow the existing config module pattern with a self export at the top of the file.

Suggested config shape:

```ts
memory: {
  enabled?: boolean
  providers?: {
    github?: {
      enabled?: boolean
      repo?: string
      max_age_days?: number
      include_authors?: string[]
      exclude_authors?: string[]
    }
  }
}
```

Policy examples:

- Disable memory globally or per provider.
- Limit retention for private PR comments.
- Prefer CODEOWNERS or maintainers when ranking confidence.
- Down-rank stale comments, one-off nits, optional suggestions, abandoned PR feedback, and comments contradicted by current docs or code.

## Implementation Slices

### PR 1: Add Generic Memory Service And Query CLI

- Add `src/memory/` with a small service API and in-memory or test-backed query implementation.
- Add `src/cli/cmd/memory.ts` with `opencode memory query <text> [--file <path>] [--json]`.
- Register `MemoryCommand` in `src/index.ts`.
- Keep this PR deterministic and avoid GitHub fetching.
- Add focused tests for query result formatting and command helpers.

Verification:

- `bun test --timeout 5000 test/cli/memory.test.ts`
- `bun typecheck`

### PR 2: Add SQLite Schema And Local Index

- Add `src/memory/memory.sql.ts`.
- Add tables for repository identity, source items, constraints, citations or source references, and sync checkpoints.
- Generate a migration with Drizzle Kit.
- Make `memory query` read from SQLite.
- Add tests for insert, dedupe, query filtering, JSON output, and citation preservation.

Verification:

- `bun run db generate --name review_memory`
- `bun test --timeout 5000 test/memory/*.test.ts`
- `bun typecheck`

### PR 3: Add GitHub Index Provider

- Add `memory index github [--repo owner/repo] [--since <date>] [--limit <n>]`.
- Use local `gh` or existing GitHub credentials.
- Fetch PR review comments and threads incrementally.
- Normalize comments into source items and initial deterministic constraints.
- Preserve citation URLs.
- Store sync checkpoints so repeated indexing is incremental.

Verification:

- `bun test --timeout 5000 test/memory/github.test.ts`
- `bun test --timeout 5000 test/cli/memory.test.ts`
- `bun typecheck`

### PR 4: Add Diff-Aware Review Command

- Add `opencode memory review [--base dev] [--pr <number>] [--json]`.
- Reuse existing repository and GitHub remote helpers where possible.
- Rank constraints by changed files, directory overlap, and diff shape.
- Print a concise human-readable checklist by default and structured results with `--json`.

Verification:

- `bun test --timeout 5000 test/cli/memory.test.ts`
- `bun test --timeout 5000 test/memory/*.test.ts`
- `bun typecheck`

### PR 5: Add Prompt Injection

- Add config-gated memory retrieval in `src/session/prompt.ts`.
- Inject a compact advisory block with citations and confidence.
- Keep token use bounded with a small result limit.
- Ensure explicit user instructions, repo instructions, ADRs, and current code remain higher priority.
- Add tests around prompt assembly and disabled config behavior.

Verification:

- `bun test --timeout 5000 test/session/*.test.ts`
- `bun test --timeout 5000 test/memory/*.test.ts`
- `bun typecheck`

### PR 6: Add Built-In Skill Or Policy Text

- Add a built-in skill only after the harness/provider layer exists.
- Teach agents when to query memory, how to handle stale or conflicting comments, and how to summarize applied historical checks.
- Do not put crawling, indexing, ranking, auth, or caching in the skill.

Verification:

- `bun test --timeout 5000 test/command/*.test.ts`
- `bun typecheck`

## Future Work

- Add LLM-assisted summarization or clustering after deterministic indexing and retrieval are stable.
- Add TUI affordances for viewing citations and accepting or dismissing retrieved constraints.
- Add provider plugin APIs once the built-in provider shape is proven.
- Add remote/team-shared indexes if local privacy and retention requirements are resolved.
- Add embeddings or full-text search if deterministic path/task matching is insufficient.

## Open Questions

- Should the initial command be `opencode memory` or `opencode review-memory`? Default recommendation: use `opencode memory` to preserve the generic provider direction.
- Should raw review comment text be stored locally? Default recommendation: store minimal normalized source text needed for deterministic extraction and citation, with retention controls before storing large raw payloads.
- Should prompt injection be enabled by default once indexing exists? Default recommendation: default to enabled only when a provider is configured and indexed data exists; otherwise stay quiet.
- Should repository identity prefer GitHub remote URL or local project ID? Default recommendation: store both when available, but key provider memory by normalized provider/repo identity.
