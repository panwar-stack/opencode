# Memory Index Progress Indicator

## Goal

Add a foreground progress indicator to `opencode memory index` so users can see that repository memory indexing is actively moving through commit crawl, file activity, and optional file summary phases.

The implementation should reuse existing CLI spinner patterns, keep the current final summary output stable, and avoid expanding the HTTP/background job surface in the first pass.

## Current State

- `packages/opencode/src/cli/cmd/memory.ts` defines `memory index` and directly awaits `Memory.Service.indexLocalRepository(...)`, then prints final totals with `console.log`.
- `packages/opencode/src/memory/memory.ts` exposes `IndexOptions` and `IndexResult`, but `IndexOptions` has no progress callback.
- `indexLocalRepository` already has clear sequential phases: resolve repo, crawl commits, replace commits, compute file activity, optionally generate summaries.
- `crawlCommits` in `packages/opencode/src/memory/memory.ts` has natural per-commit progress points after candidate discovery.
- `generateFileSummaries` in `packages/opencode/src/memory/memory.ts` summarizes selected files with `Effect.forEach(..., { concurrency: 2 })`.
- `packages/opencode/src/cli/effect/prompt.ts` already wraps `@clack/prompts` for Effect-based CLI commands, but its spinner wrapper currently exposes only `start` and `stop`.
- `packages/opencode/test/cli/memory.test.ts` asserts stable stdout summary lines like `Commits indexed: 1` and `File summaries generated: 1`.
- `packages/web/src/content/docs/cli.mdx` and `packages/web/src/content/docs/memory.mdx` document `opencode memory index`.

## Non-Negotiables

- Keep final `memory index` summary lines on stdout unchanged for tests and scripts.
- Put progress/status output on the existing spinner/status channel, not in the machine-readable final summary.
- Do not add a new progress dependency; reuse `@clack/prompts` through `packages/opencode/src/cli/effect/prompt.ts`.
- Do not add HTTP background-job progress fields in the first pass.
- Do not change memory storage schema.
- Progress reporting must be best-effort UI only; indexing behavior and returned `IndexResult` must remain deterministic.

## Progress Design

Add an optional progress callback to memory indexing:

```ts
type IndexProgress =
  | { phase: "resolve" }
  | { phase: "crawl"; current?: number; total?: number }
  | { phase: "store"; indexed: number; skipped: number }
  | { phase: "activity" }
  | { phase: "summaries"; current?: number; total?: number }
```

Extend `IndexOptions` in `packages/opencode/src/memory/memory.ts`:

```ts
onProgress?: (progress: IndexProgress) => Effect.Effect<void>
```

Behavior:

- `indexLocalRepository` must call `onProgress` at phase boundaries.
- `crawlCommits` should report `total` after `git log` candidates are known and increment `current` after each candidate is processed.
- `generateFileSummaries` should report summary progress for selected files only.
- If `summaries <= 0`, skip summary progress and keep existing summary pruning behavior.
- Progress callback failures should fail the command, because CLI output errors indicate a broken terminal/runtime path and should not be silently hidden.

## CLI Behavior

- `opencode memory index` should start a spinner before indexing begins.
- Spinner messages should update from progress events, for example:
- `Resolving repository...`
- `Crawling commits 42/7000...`
- `Writing memory index...`
- `Computing file activity...`
- `Generating file summaries 8/200...`
- On success, stop the spinner with `Memory index complete`.
- On failure, stop the spinner with `Memory index failed` before returning the original error.
- The existing final stdout block must remain unchanged:
- `Repository: ...`
- `Worktree: ...`
- `Commits indexed: ...`
- `Commits skipped: ...`
- `File activity records: ...`
- `File summaries generated: ...`

## Implementation Slices

### PR 1: Add Memory Index Progress Events

- Add `IndexProgress` and optional `onProgress` to `IndexOptions` in `packages/opencode/src/memory/memory.ts`.
- Emit progress events from `indexLocalRepository` around repository resolution, commit crawling, commit storage, file activity computation, and summary generation.
- Thread progress into `crawlCommits` and `generateFileSummaries` without changing returned `IndexResult`.
- Add or update service-level tests in `packages/opencode/test/memory/index.test.ts` to assert ordered phase events for a small fixture repo.
- Add or update summary tests in `packages/opencode/test/memory/summary.test.ts` to assert summary progress is omitted when `summaries: 0`.

Verification:

- `cd packages/opencode && bun test test/memory/index.test.ts test/memory/summary.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Reviewers should focus on whether progress events are emitted at stable, deterministic points and whether the callback shape avoids leaking CLI concerns into the memory service.

### PR 2: Wire Progress Into CLI Spinner

- Extend `Prompt.spinner()` in `packages/opencode/src/cli/effect/prompt.ts` to expose a `message(msg)` method matching the underlying `@clack/prompts` spinner capability.
- Update `packages/opencode/src/cli/cmd/memory.ts` to create a spinner and pass `onProgress` into `memory.indexLocalRepository`.
- Keep all existing final `console.log` summary lines unchanged.
- Ensure failure handling stops the spinner without swallowing the original indexing error.
- Update `packages/opencode/test/cli/memory.test.ts` to preserve existing stdout assertions and, if practical, assert only stable stderr/status text rather than spinner frames.
- Update `packages/web/src/content/docs/cli.mdx` and `packages/web/src/content/docs/memory.mdx` to mention that `opencode memory index` shows foreground progress.

Verification:

- `cd packages/opencode && bun test test/cli/memory.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Reviewers should focus on stdout compatibility, clean Effect error handling, and whether spinner messages are useful without being noisy.

## Future Work

- Add progress fields to `BackgroundJob.Info` for `POST /memory/index`.
- Surface memory indexing progress in TUI memory screens.
- Add a `--quiet` flag only if users need to suppress interactive progress beyond current non-TTY behavior.

## Open Questions

- Should per-commit progress update every commit or be throttled? Default: update every commit first, then throttle later only if real repos show terminal overhead.
- Should progress appear in non-TTY environments? Default: rely on existing `@clack/prompts` behavior and keep final stdout stable.
