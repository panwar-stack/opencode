# TUI Prompt Footer AI Processing Time

## Goal

Render persisted cumulative AI processing time in the main TUI prompt footer, positioned to the left of the existing token count/cost display and near the `Ctrl+P commands` hint.

This supersedes the earlier wall-clock elapsed session age behavior. The footer must read the persisted `session.time.processing` duration and must not derive time from `session.time.created` or a local idle timer.

## Current State

- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` owns the main prompt UI.
- The footer row containing token usage and `Ctrl+P commands` is rendered in `Prompt`.
- `usage()` in `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` already reads the current session via `sync.session.get(props.sessionID)`.
- The token count/cost text is rendered before the command palette shortcut.
- `paletteShortcut = useCommandShortcut("command.palette.show")` supplies the `Ctrl+P` command hint.
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx` exposes synced session data through `sync.session.get(sessionID)`.
- Session objects include persisted `time.processing` in milliseconds.
- `packages/opencode/src/util/format.ts` already exports `formatDuration(secs: number)` for compact duration strings.

## Non-Negotiables

- Must render AI processing time to the left of token count/cost.
- Must keep `Ctrl+P commands` behavior unchanged.
- Must not add new API, database, SDK, or migration work in this TUI slice.
- Must not add a user-facing config option in the first pass.
- Must not compute displayed time from `session.time.created`.
- Must not tick or change while the user is idle unless synced session data changes.
- Must render as `AI <duration>`.
- Must show `AI 0s` when session data exists but no AI processing has completed.
- Must hide AI processing time only when session data is not available.
- Must use existing formatting helpers instead of adding a new duration formatter.

## TUI Behavior

The prompt footer should render metadata in this order:

```text
AI <duration>  <token count/cost>  <Ctrl+P commands>
```

Example:

```text
AI 1m 12s  22,104 tokens · $0.05  Ctrl+P commands
```

Behavior details:

- Source: `sync.session.get(props.sessionID)?.time.processing`
- Formatting: `formatDuration(Math.floor(processingMs / 1000)) || "0s"`
- If token usage is not available, AI processing time should still render before `Ctrl+P commands`
- If session data exists and processing time is `0`, render `AI 0s`
- If session data is missing, AI processing time should not render

## Implementation Slices

### PR 3: Switch Footer To AI Processing Time

- Update `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`.
- Remove the wall-clock `now` signal and one-second timer used for elapsed session age.
- Add an `elapsed` memo based on `sync.session.get(props.sessionID)?.time.processing`.
- Render `AI <duration>` immediately before the existing `usage()` footer block.
- Style AI processing time with the same muted treatment as adjacent footer metadata.
- Keep token/cost and command shortcut rendering unchanged.

Verification:

- `cd packages/opencode && bun typecheck`

## Future Work

- Add live in-flight ticking for the current active LLM step by exposing an active processing start timestamp.
- Add separate metrics for tool execution time if users want agent runtime split by LLM, tools, and waiting.
- Add a config option to hide AI processing time.

## Open Questions

- Resolved: render `AI <duration>` to avoid implying wall-clock session age.
