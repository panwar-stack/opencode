# GitHub Review Memory From Closed PRs

## Feature Highlights

- Prefer review memory from merged PRs first, then closed-unmerged PRs, then open PRs.
- Store PR state metadata with indexed GitHub review comments without requiring a database migration.
- Enrich review memory with best-effort PR commit summaries so future guidance can reflect the accepted final state.
- Surface PR state in review-memory output while keeping text output compact.

## Goal

Make GitHub-backed review memory prefer review comments from closed PRs, especially merged PRs, before using comments from open or abandoned work. When PR commit history is available, index enough commit context to understand how the PR evolved into the final approved version so future review guidance reflects the accepted outcome, not just an intermediate review remark.

The first implementation should extend the existing native memory provider and CLI review flow. It must not turn `github run` into the local review-memory UX.

## Current State

- `packages/opencode/src/memory/github.ts` indexes repository-wide PR review comments through `gh api -X GET repos/<repo>/pulls/comments -f sort=updated -f direction=asc -f per_page=100 -f page=<n>`.
- `packages/opencode/src/memory/github.ts` converts each GitHub review comment into one compact memory constraint and parses `pr_number` from the comment URL.
- `packages/opencode/src/memory/memory.sql.ts` already stores source item fields like `pr_number`, `author`, `url`, `path`, `line`, `position`, `labels`, timestamps, `source_cursor`, and generic `metadata`.
- `packages/opencode/src/memory/memory.sql.ts` does not have first-class columns for PR state, merged state, closed timestamp, title, commit SHAs, commit messages, or final head SHA.
- `packages/opencode/src/memory/repo.ts` dedupes constraints by `repository_id + text` and only queries active constraints.
- `packages/opencode/src/memory/search.ts` uses deterministic term scoring and optional exact file filtering.
- `packages/opencode/src/cli/cmd/memory.ts` exposes `opencode memory index github`, `opencode memory query`, and `opencode memory review`.
- `packages/opencode/src/cli/cmd/memory.ts` implements `memory review --pr <number>` by fetching PR files only through `gh api repos/<repo>/pulls/<pr>/files --paginate --jq '.[] | [.filename, .status] | @tsv'`.
- `packages/opencode/src/cli/cmd/memory.ts` currently ranks review memory by exact file overlap, directory overlap, changed status term match, then search score.
- `packages/opencode/src/session/prompt.ts` injects review memory only when `memory.enabled === true`, using the latest user message as the query text.
- `packages/opencode/src/cli/cmd/github.ts` separately fetches PR title, body, state, files, reviews, nested review comments, and first 100 commits for GitHub Actions automation. This path is not the local memory provider.

## Non-Negotiables

- Closed and merged PR comments must rank ahead of otherwise-equivalent comments from open PRs.
- Merged PRs must rank ahead of closed-unmerged PRs because merged PRs best represent accepted project decisions.
- Open PR comments must remain indexable and queryable as fallback memory.
- Commit history enrichment must be best-effort. If GitHub commit fetching fails or returns no commits, indexing review comments must still succeed.
- Do not require a database migration in the first pass unless metadata-based storage is insufficient. Prefer storing PR metadata and commit summaries in `memory_source_item.metadata`.
- Do not call GitHub once per comment when multiple comments belong to the same PR. Fetch PR metadata and commits once per unique `pr_number` per indexing run.
- Do not index full diffs or patch bodies in the first pass.
- Do not change generated SDKs unless API surfaces change. If generated clients are affected, run `./packages/sdk/js/script/build.ts`.

## GitHub Indexing Design

Extend `packages/opencode/src/memory/github.ts` so indexing has three stages:

1. Fetch review comments with the existing repository-wide endpoint.
2. Extract unique PR numbers from the comments.
3. Fetch PR metadata and optional commit summaries for those PRs.

Use GitHub REST endpoints through `gh api`:

```sh
gh api repos/<owner>/<repo>/pulls/<pr_number>
gh api repos/<owner>/<repo>/pulls/<pr_number>/commits --paginate
```

Expected PR metadata shape stored in source item `metadata`:

```ts
{
  pr: {
    number: number
    title: string
    state: "open" | "closed"
    merged: boolean
    closed_at?: string
    merged_at?: string
    base_ref?: string
    head_ref?: string
    head_sha?: string
  }
  commits?: Array<{
    sha: string
    message: string
    author?: string
    authored_at?: string
  }>
}
```

Commit storage constraints:

- Store only the first line of each commit message.
- Store at most 50 commits per PR in metadata.
- Preserve order returned by GitHub.
- Include the final commit SHA when available through PR metadata as `pr.head_sha`.
- Do not infer approval from commit messages.

## Ranking Design

Update review-memory ranking in `packages/opencode/src/cli/cmd/memory.ts` and any shared ranking helper so PR state contributes after file/directory relevance but before plain term score.

Ranking order must be deterministic:

1. Exact file overlap.
2. Directory overlap.
3. PR state weight.
4. Changed file status term match.
5. Existing search score.
6. Recency or stable citation/source ID tie-breaker.

PR state weights:

```ts
merged closed PR: +30
closed unmerged PR: +15
open PR: +0
unknown PR state: +0
```

The ranking must treat missing metadata as `unknown`, not as an error.

## Query And Output Behavior

`opencode memory query` should continue returning the same primary fields unless JSON output already includes source metadata.

`opencode memory review --json` should expose enough metadata to debug ranking:

```ts
{
  id: string
  title: string
  body: string
  score: number
  file?: string
  files?: string[]
  citations?: Array<{ url: string; title?: string }>
  metadata?: {
    pr?: {
      number: number
      state: "open" | "closed"
      merged: boolean
      closed_at?: string
      merged_at?: string
      title?: string
    }
    commits?: Array<{
      sha: string
      message: string
    }>
  }
}
```

Text output should stay compact:

- Keep existing citation display.
- Add PR state only when available, for example: `PR #123 merged`.
- Do not print commit history in text output by default.

## Failure Modes

- If `gh api repos/<repo>/pulls/<pr>` fails for one PR, index comments for that PR with `metadata.pr` omitted and continue.
- If `gh api repos/<repo>/pulls/<pr>/commits --paginate` fails, store PR metadata without `metadata.commits` and continue.
- If a review comment has no parseable PR number, keep existing behavior and index it without PR metadata.
- If PR metadata conflicts with comment timestamps, do not rewrite comment timestamps. Store PR timestamps separately in metadata.
- If commit history exceeds 50 commits, truncate to 50 and keep `pr.head_sha` so the final PR state remains identifiable.

## Implementation Slices

### PR 1: Index PR State For Review Comments

- Extend `packages/opencode/src/memory/github.ts` to collect unique PR numbers from fetched review comments.
- Add a small GitHub metadata fetch path for `repos/<repo>/pulls/<pr_number>`.
- Store PR metadata in `memory_source_item.metadata` through the existing source item path.
- Keep the existing review-comment checkpoint behavior unchanged.
- Add tests in `packages/opencode/test/memory/github.test.ts` for:
- merged PR metadata stored on source items
- closed-unmerged PR metadata stored on source items
- failed PR metadata fetch does not fail indexing
- duplicate PR numbers only fetch metadata once

Verification:

- `cd packages/opencode && bun test --timeout 5000 test/memory/github.test.ts`
- `cd packages/opencode && bun typecheck`

### PR 2: Rank Closed And Merged PR Comments First

- Update ranking in `packages/opencode/src/cli/cmd/memory.ts` to read PR state from source metadata.
- Apply deterministic PR state weights after exact file and directory relevance.
- Preserve current behavior for memory entries without PR metadata.
- Extend `packages/opencode/test/cli/memory.test.ts` with ranking cases where:
- same file match from merged PR beats same file match from open PR
- same directory match from merged PR beats same directory match from closed-unmerged PR
- exact file match from open PR still beats directory-only match from merged PR
- missing PR metadata does not throw

Verification:

- `cd packages/opencode && bun test --timeout 5000 test/cli/memory.test.ts`
- `cd packages/opencode && bun typecheck`

### PR 3: Add Commit History Context To Indexed Memory

- Extend `packages/opencode/src/memory/github.ts` to fetch `repos/<repo>/pulls/<pr_number>/commits --paginate` after PR metadata succeeds.
- Store up to 50 commit summaries in `memory_source_item.metadata.commits`.
- Store only commit SHA, first-line message, optional author, and optional authored timestamp.
- Add tests in `packages/opencode/test/memory/github.test.ts` for:
- commit summaries are stored in order
- multiline commit messages are truncated to first line
- commit history is capped at 50 entries
- commit fetch failure does not fail comment indexing

Verification:

- `cd packages/opencode && bun test --timeout 5000 test/memory/github.test.ts`
- `cd packages/opencode && bun typecheck`

### PR 4: Surface PR Context In Review Output

- Update `packages/opencode/src/cli/cmd/memory.ts` JSON review output to include PR metadata and commit summaries when present.
- Update text review output to include compact PR state, such as `PR #123 merged`.
- Do not print commit history in text output unless a separate flag is added later.
- Extend `packages/opencode/test/cli/memory.test.ts` for JSON and text formatting.

Verification:

- `cd packages/opencode && bun test --timeout 5000 test/cli/memory.test.ts`
- `cd packages/opencode && bun typecheck`

## Future Work

- Add a `--with-commits` or `--json`-only detailed mode for displaying commit history in review output.
- Add config in `packages/opencode/src/config/memory.ts` for commit history limits if 50 is not a good default.
- Use PR labels, review decisions, and resolved-thread state if GitHub exposes enough reliable data through the chosen API.
- Refactor shared GitHub PR fetching between `packages/opencode/src/cli/cmd/github.ts` and `packages/opencode/src/memory/github.ts` only after the local memory behavior is stable.
- Add prompt injection that includes changed files and PR metadata, not only the latest user message.

## Open Questions

- Should closed-unmerged PR comments be treated as useful guidance or mostly fallback memory? Default recommendation: keep them useful but lower than merged PRs because they may contain valid review advice from abandoned work.
- Should commit summaries influence ranking in the first pass? Default recommendation: no. Store them first, expose them in JSON, and add ranking only after observing real review-memory quality.
