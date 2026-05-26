# Resolved PR Comments In Memory Index

## Goal

Add resolved GitHub PR review comments to repository memory when running `opencode memory index`, controlled by an explicit CLI option with a default value.

Default behavior: `opencode memory index` includes resolved PR review-thread comments when GitHub ingestion is available. Users can opt out with `--no-resolved-pr-comments`. Local git indexing must still succeed when GitHub auth, remotes, or API access are unavailable.

## Current State

- `packages/opencode/src/cli/cmd/memory.ts` defines `IndexCommand` for `opencode memory index`.
- Current CLI options include `--github` / `--no-github`, but this does not call GitHub. It only controls offline issue-number parsing in memory indexing.
- `packages/opencode/src/memory/memory.ts` defines `IndexOptions` and `indexLocalRepository(input?: IndexOptions)`.
- `crawlCommits(...)` stores commit message, changed files, diff, and optional `issue_number` in repository memory.
- `packages/opencode/src/memory/memory.sql.ts` has `repository_memory_commit`, but no table for PR comments, review threads, resolved state, author, URL, or PR number.
- `packages/opencode/src/cli/cmd/github.ts` has adjacent GitHub GraphQL code for prompt context, but it does not persist memory and does not fetch `reviewThreads.isResolved`.
- `packages/opencode/specs/remove-github-review-memory.md` removed old review-memory behavior, so this work must avoid reintroducing prompt-injection-style review memory paths.
- Docs likely needing updates:
- `packages/web/src/content/docs/cli.mdx`
- `packages/web/src/content/docs/memory.mdx`
- `packages/opencode/specs/repository-memory.md`

## Non-Negotiables

- Add a new CLI option instead of changing the meaning of existing `--github`.
- Default to including resolved PR comments: `--resolved-pr-comments` defaults to `true`.
- Support opt-out via `--no-resolved-pr-comments`.
- Do not fail local indexing when GitHub is unavailable, unauthenticated, rate-limited, or missing permissions.
- Do not store PR comments by appending lossy text into commit `token_text`; preserve source metadata.
- Store enough metadata to explain where a memory result came from.
- Keep private PR comments local to the repository memory database.
- Leave bot/comment filtering out of the first pass unless tests prove it is necessary.
- Leave unresolved comment ingestion out of scope unless it is needed to model the resolved-thread API cleanly.

## CLI Behavior

Add to `packages/opencode/src/cli/cmd/memory.ts`:

```sh
opencode memory index --resolved-pr-comments
opencode memory index --no-resolved-pr-comments
```

Behavior:

- `--resolved-pr-comments` defaults to `true`.
- `--no-github` disables all GitHub-derived indexing, including resolved PR comments.
- `--no-resolved-pr-comments` disables resolved PR comment ingestion while preserving existing commit indexing and issue-number parsing behavior.
- If GitHub cannot be queried, index local commits and summaries normally, and report a non-fatal progress warning.

Service option shape in `packages/opencode/src/memory/memory.ts`:

```ts
type IndexOptions = {
  noGithub?: boolean
  resolvedPrComments?: boolean
}
```

Effective behavior:

```ts
const shouldIndexResolvedPrComments = !input.noGithub && input.resolvedPrComments !== false
```

## Storage

Add a new migration under `packages/opencode/migration/...` and update `packages/opencode/src/memory/memory.sql.ts`.

Proposed table:

```ts
repository_memory_pr_comment {
  repository_id: string
  pr_number: number
  thread_id: string
  comment_id: string
  database_id?: number
  author?: string
  body: string
  path?: string
  line?: number
  url?: string
  created_at?: number
  is_resolved: boolean
  is_outdated?: boolean
  token_text: string
}
```

Indexing semantics:

- Replace PR comment rows for the repository during `memory index`, matching the existing full-refresh behavior for commit rows.
- Only store comments from threads where `isResolved === true`.
- Store all comments in a resolved thread, not only the last comment.
- Include PR number, path, line, author, and URL in `token_text` so search/examine results have useful context.

## GitHub Fetching

Implement a focused GitHub fetcher for memory indexing instead of reusing prompt-building code from `packages/opencode/src/cli/cmd/github.ts`.

GraphQL shape should use PR review threads because resolved state lives on the thread:

```graphql
repository(owner: $owner, name: $name) {
  pullRequest(number: $number) {
    reviewThreads(first: 100, after: $cursor) {
      nodes {
        id
        isResolved
        isOutdated
        path
        line
        comments(first: 100) {
          nodes {
            id
            databaseId
            body
            url
            createdAt
            author {
              login
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
```

Failure modes:

- No GitHub remote: skip PR comment indexing.
- No `gh` auth or token: skip PR comment indexing.
- GraphQL permission error: skip PR comment indexing and continue local memory indexing.
- Pagination beyond 100 threads/comments: must paginate thread pages; comment pagination can be added if the API response shows truncation.

## Search And Examine Behavior

- Include PR comment rows in memory search results as their own source type, not as synthetic commits.
- Search results should identify source as `pr_comment`.
- Examine output should show PR number, thread path/line, author, URL, and body.
- Existing commit search behavior must remain unchanged when no PR comments are indexed.

## Implementation Slices

### PR 1: CLI And Option Plumbing

- Add `resolvedPrComments?: boolean` to `IndexOptions` in `packages/opencode/src/memory/memory.ts`.
- Add `--resolved-pr-comments` / `--no-resolved-pr-comments` to `IndexCommand` in `packages/opencode/src/cli/cmd/memory.ts`.
- Default the option to `true`.
- Ensure `--no-github` takes precedence over `--resolved-pr-comments`.
- Add CLI tests in `packages/opencode/test/cli/memory.test.ts` for default option and opt-out parsing.
- Do not add GitHub API fetching in this slice.

Verification:

- `cd packages/opencode && bun test test/cli/memory.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only reviewer to verify the diff only adds option plumbing, preserves existing `--github` behavior, and does not introduce network calls.

### PR 2: Storage For Resolved PR Comments

- Add a migration for `repository_memory_pr_comment`.
- Update `packages/opencode/src/memory/memory.sql.ts`.
- Add insert/delete helpers near existing repository-memory persistence code.
- Add low-level tests in `packages/opencode/test/memory/memory.test.ts`.
- Keep search integration out of this slice unless required by table tests.

Verification:

- `cd packages/opencode && bun test test/memory/memory.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only reviewer to check migration reversibility assumptions, local privacy implications, and that PR comments are stored with source metadata rather than folded into commit rows.

### PR 3: GitHub Resolved Thread Ingestion

- Add a memory-specific GitHub fetcher for resolved PR review threads.
- Resolve owner/repo from the current git remote.
- Discover candidate PR numbers from indexed commits, using existing `parseIssueNumber(...)` behavior where possible.
- Fetch `reviewThreads` and keep only `isResolved === true`.
- Treat GitHub failures as non-fatal and continue local indexing.
- Add service tests in `packages/opencode/test/memory/index.test.ts` using deterministic fixtures or a fake fetch boundary.

Verification:

- `cd packages/opencode && bun test test/memory/index.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only reviewer to check pagination, failure handling, default behavior, and that unavailable GitHub access does not break local indexing.

### PR 4: Search, Examine, And Docs

- Include PR comment rows in memory search.
- Update examine output to support `pr_comment` results.
- Update docs:
- `packages/web/src/content/docs/cli.mdx`
- `packages/web/src/content/docs/memory.mdx`
- `packages/opencode/specs/repository-memory.md`
- Add search/examine tests covering a resolved PR comment result.

Verification:

- `cd packages/opencode && bun test test/memory/index.test.ts test/memory/memory.test.ts test/cli/memory.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only reviewer to verify result attribution, docs accuracy, and that existing commit-memory search behavior is unchanged.

## Future Work

- Add API parity to `packages/opencode/src/server/routes/instance/httpapi/groups/memory.ts`.
- Regenerate SDK with `./packages/sdk/js/script/build.ts` if API parity is added.
- Add config-level defaults in `packages/opencode/src/config/memory.ts`.
- Support unresolved PR comments as a separate opt-in source.
- Add bot/comment-author filtering.
- Add richer ranking for PR comments versus commits and summaries.

## Open Questions

- Should the option name be `--resolved-pr-comments` or `--github-resolved-pr-comments`? Default recommendation: use `--resolved-pr-comments` because it is shorter and scoped under `memory index`.
- Should HTTP `/memory/index` expose the same option in the first pass? Default recommendation: no, keep the first pass CLI-only and add API parity later if needed.
