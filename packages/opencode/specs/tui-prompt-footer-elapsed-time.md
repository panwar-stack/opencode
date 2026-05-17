# TUI Prompt Footer Elapsed Time

## Goal

Add an elapsed session time indicator to the main TUI prompt footer, positioned to the left of the existing token count/cost display and near the `Ctrl+P commands` hint.

This should be a minimal UI-only change in the prompt footer. Use the existing synced session creation timestamp and existing duration formatting helper; do not add new storage, API fields, config, or SDK changes.

## Current State

- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` owns the main prompt UI.
- The footer row containing token usage and `Ctrl+P commands` is rendered in `Prompt`.
- `usage()` in `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` already reads the current session via `sync.session.get(props.sessionID)`.
- The token count/cost text is rendered before the command palette shortcut.
- `paletteShortcut = useCommandShortcut("command.palette.show")` supplies the `Ctrl+P` command hint.
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx` exposes synced session data through `sync.session.get(sessionID)`.
- Session objects already include `time.created`.
- `packages/opencode/src/util/format.ts` already exports `formatDuration(secs: number)` for compact duration strings.

## Non-Negotiables

- Must render elapsed time to the left of token count/cost.
- Must keep `Ctrl+P commands` behavior unchanged.
- Must not add new API, database, SDK, or migration work.
- Must not add a user-facing config option in the first pass.
- Must update once per second while the TUI is open.
- Must clean up the timer interval on component unmount.
- Must hide elapsed time when session data is not available.
- Must use existing formatting helpers instead of adding a new duration formatter.

## TUI Behavior

The prompt footer should render metadata in this order:

```text
<elapsed time>  <token count/cost>  <Ctrl+P commands>
```

Example:

```text
4m 12s  22,104 tokens · $0.05  Ctrl+P commands
```

Behavior details:

- Start time: `sync.session.get(props.sessionID)?.time.created`
- End time: `Date.now()`
- Update frequency: once per second
- Formatting: `formatDuration(Math.floor(elapsedMs / 1000))`
- Negative elapsed time should be clamped to `0s`
- If token usage is not available, elapsed time should still render before `Ctrl+P commands`
- If session data is missing, elapsed time should not render

## Implementation Slices

### PR 1: Add Elapsed Time Rendering

- Update `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`.
- Add a `now` signal initialized with `Date.now()`.
- Add a one-second interval that updates `now`.
- Clean up the interval with `onCleanup`.
- Add an `elapsed` memo based on `sync.session.get(props.sessionID)?.time.created`.
- Render elapsed time immediately before the existing `usage()` footer block.
- Style elapsed time with the same muted treatment as adjacent footer metadata.

Verification:

- `cd packages/opencode && bun typecheck`

### PR 2: Add Focused Coverage

- Add or extend a TUI test for the prompt footer.
- Verify elapsed time renders when the synced session has `time.created`.
- Verify elapsed time is hidden when session data is unavailable.
- Verify token usage and `Ctrl+P commands` still render in the expected order.

Verification:

- `cd packages/opencode && bun test test/cli/cmd/tui`
- `cd packages/opencode && bun typecheck`

## Future Work

- Add a config option to hide elapsed time.
- Add a labeled format such as `elapsed 4m 12s`.
- Add elapsed time to subagent footers if users want consistent footer metadata there.
- Add pause/resume semantics if sessions later track active time separately from wall-clock time.

## Open Questions

- Should the footer show only `4m 12s` or a labeled value like `elapsed 4m 12s`? Default recommendation: use only `4m 12s` to preserve footer space.
