# Recursive TUI Export

## Goal

Make the TUI `/export` slash command export the active session plus every descendant session, so teammate sessions and nested subagent sessions appear in the Markdown export.

The first pass should reuse the existing child-session model rather than introducing team-specific export state. Teammates are included because `team_spawn` creates teammate sessions with `parentID` set to the lead session.

## Current State

- TUI `/export` is implemented in `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1040-1098`.
- It currently formats only the active session and the active session's in-memory `messages()` list.
- Markdown formatting lives in `packages/opencode/src/cli/cmd/tui/util/transcript.ts`.
- Export options live in `packages/opencode/src/cli/cmd/tui/ui/dialog-export-options.tsx`.
- CLI JSON export already has recursive collection in `packages/opencode/src/cli/cmd/export.ts:228-248`.
- `Session.children(parentID)` exists in `packages/opencode/src/session/session.ts:700-709`, but returns only direct children and does not sort.
- Child relationships are stored as `session.parent_id` in `packages/opencode/src/session/session.sql.ts:16-60`.
- Teammates are child sessions created by `packages/opencode/src/tool/team_spawn.ts:161-179`.
- Subagents are child sessions created by `packages/opencode/src/tool/task.ts:152-169`.
- Existing recursive export coverage exists in `packages/opencode/test/cli/cmd/export.test.ts`.

## Non-Negotiables

- `/export` must include the active session and all descendant sessions by default.
- Traversal must be recursive, not direct-children-only.
- Traversal must be deterministic: sort siblings by `time.created`, then `id`.
- Do not add a new team-specific storage model for export.
- Do not require a live active team to export teammate sessions; persisted child sessions are enough.
- Existing export options for thinking, tool details, assistant metadata, filename, and open-without-saving must continue to apply.
- Existing single-session transcript formatting behavior must remain reusable for copy transcript.
- Export must tolerate sessions with no messages.
- Leave mailbox/team task export out of the first pass unless a reviewer explicitly expands scope.

## Markdown Export Design

Add a recursive transcript formatter that keeps the existing single-session format intact and composes multiple sessions into one Markdown document.

Recommended shape:

```markdown
# <root session title>

**Session ID:** <root id>
**Created:** <date>
**Updated:** <date>

---

## Session: <root session title>

**Session ID:** <root id>
**Depth:** 0

<existing message transcript>

---

## Child Session: <child title>

**Session ID:** <child id>
**Parent Session ID:** <parent id>
**Depth:** 1

<existing message transcript>
```

Behavior:

- Root session appears first.
- Children appear depth-first.
- Siblings are sorted by `time.created`, then `id`.
- Section headings must distinguish root, child, and nested child sessions.
- Existing `formatTranscript(...)` should remain available for current copy-transcript behavior.
- Add a new formatter or wrapper in `packages/opencode/src/cli/cmd/tui/util/transcript.ts` instead of overloading all current callers.

## Collection Design

Add shared TUI export collection logic that returns a tree:

```ts
type ExportSession = {
  info: Session.Info
  messages: MessageV2.WithParts[]
  children: ExportSession[]
}
```

Collection rules:

- Root messages may use the current TUI state only if it is complete enough for parity with today.
- Child and descendant messages must be fetched explicitly via session/message APIs or service calls.
- Each node must include `Session.Info`, chronological `MessageV2.WithParts[]`, and recursively collected children.
- Sort direct children before recursion.
- Do not filter archived child sessions in the first pass unless existing `Session.children(...)` already does.

Recommended implementation location:

- `packages/opencode/src/cli/cmd/tui/util/session-export.ts`

Potential function shape:

```ts
export async function collectExportSession(sessionID: string): Promise<ExportSession>
```

If the TUI cannot call session services directly and needs HTTP routes, use existing endpoints first:

- `GET /session/:sessionID/children`
- `GET /session/:sessionID/message`

Only add new API surface if existing pagination makes full recursive collection impractical.

## TUI Behavior

Update `/export` in `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`:

- After options are accepted, collect the recursive export tree for `session().id`.
- Format the recursive Markdown document.
- Preserve existing save/open behavior.
- Preserve existing toast behavior, with the success message still naming the exported filename.
- Failure toast may stay `Failed to export session`.

Docs/UI text updates:

- Update `packages/opencode/src/cli/cmd/tui/config/keybind.ts:71` from "Export session to editor" to mention descendants or child sessions.
- Update `packages/opencode/src/cli/cmd/tui/feature-plugins/home/tips-view.tsx:185` so `/export` says it saves the conversation plus child/teammate sessions as Markdown.

## Implementation Slices

### PR 1: Recursive Collection Utility

- Add `collectExportSession(...)` for recursive session export collection.
- Reuse the same traversal semantics as `packages/opencode/src/cli/cmd/export.ts`.
- Sort children by `time.created`, then `id`.
- Add unit coverage for root, teammate child, nested subagent child, and sibling ordering.
- Do not change TUI behavior yet.

Verification:

- `cd packages/opencode && bun test test/cli/cmd/export.test.ts`
- `cd packages/opencode && bun test <new recursive export utility test>`
- `cd packages/opencode && bun typecheck`

Review:

Confirm the collector uses the existing `parentID` model, has deterministic ordering, and does not introduce team-specific export coupling.

### PR 2: Recursive Markdown Formatting

- Add a recursive Markdown formatter in `packages/opencode/src/cli/cmd/tui/util/transcript.ts`.
- Preserve existing `formatTranscript(...)` output for current tests.
- Add tests for multi-session output, heading hierarchy, empty child sessions, and option propagation for thinking/tool details/assistant metadata.

Verification:

- `cd packages/opencode && bun test test/cli/tui/transcript.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Confirm the Markdown is readable, deterministic, and does not duplicate or regress existing single-session transcript behavior.

### PR 3: Wire `/export` To Recursive Export

- Update `/export` in `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` to call the recursive collector.
- Pass the collected tree into the recursive Markdown formatter.
- Keep filename, editor, write-back, and toast behavior unchanged.
- Update keybinding/help text that describes `/export`.

Verification:

- `cd packages/opencode && bun test test/cli/tui/transcript.test.ts`
- `cd packages/opencode && bun test test/cli/cmd/export.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Manually verify a session with a teammate child exports both the lead transcript and teammate transcript from the TUI `/export` command.

### PR 4: Add API Surface Only If Needed

- If TUI cannot collect full child message trees through existing service/client paths, add the smallest API needed.
- Prefer a recursive export endpoint over many TUI-side paginated calls only if it materially reduces complexity.
- If an API or generated client changes, regenerate the JavaScript SDK.

Verification:

- `cd packages/opencode && bun test test/server/httpapi-team.test.ts`
- `cd packages/opencode && bun test test/server/session-list.test.ts`
- `cd packages/opencode && bun typecheck`
- `./packages/sdk/js/script/build.ts`

Review:

Confirm the API is necessary, scoped to export collection, and does not expose team/member data that recursive child sessions already cover.

## Future Work

- Add export options to include team mailbox messages from `team_message` and `team_message_recipient`.
- Add export options to include team tasks from `team_task`.
- Add a JSON export option to TUI that matches CLI `export [sessionID]`.
- Add a UI checkbox to exclude child sessions if users want the old single-session export.

## Open Questions

- Should `/copy transcript` also include child sessions? Default recommendation: no, keep copy transcript single-session for quick clipboard use and limit this change to `/export`.
- Should archived child sessions be included? Default recommendation: yes, include all persisted descendants returned by `Session.children(...)` for deterministic completeness.
- Should teammate metadata from `team_member` appear in headings? Default recommendation: leave out of first pass; session title already contains teammate context from `team_spawn`.
