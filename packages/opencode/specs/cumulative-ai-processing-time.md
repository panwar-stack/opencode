# Cumulative AI Processing Time

## Goal

Change the TUI elapsed time indicator from wall-clock session age to cumulative AI processing time for the session.

The displayed value must count only time spent processing AI responses. It must not include user idle time between prompts, time since session creation, or time waiting for the user. Implement this as a persisted session usage metric accumulated from completed LLM steps, then render that persisted value in the prompt footer.

## Current State

- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:357` creates a `now` signal and updates it once per second.
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:365` computes `elapsed` as `Date.now() - sync.session.get(props.sessionID)?.time.created`.
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx:1771` renders the elapsed value before token usage and command hints.
- `packages/opencode/specs/tui-prompt-footer-elapsed-time.md:7` explicitly scoped the current feature as UI-only with no storage/API changes. That constraint no longer fits this requirement.
- `packages/opencode/src/session/session.sql.ts:36` through `packages/opencode/src/session/session.sql.ts:41` already persist cumulative cost and token usage on the `session` table.
- `packages/opencode/src/session/projectors.ts:32` accumulates cost and tokens from `step-finish` parts through `applyUsage`.
- `packages/opencode/src/session/projectors.ts:188` through `packages/opencode/src/session/projectors.ts:191` already subtracts previous step usage and adds new step usage when a `PartUpdated` event changes.
- `packages/opencode/src/session/processor.ts:484` emits a `step-start` part.
- `packages/opencode/src/session/processor.ts:516` emits a `step-finish` part with tokens and cost.
- `packages/opencode/src/session/message-v2.ts:229` defines `StepFinishPart`; it currently has cost and tokens but no duration.
- `packages/opencode/src/session/session.ts:187` defines the session `time` object with timestamps only.
- `packages/opencode/src/v2/session.ts:25` defines `SessionV2.Info`, which exposes cost, tokens, and timestamps from the same session table.
- `packages/sdk/js/src/gen/types.gen.ts:533` and `packages/sdk/js/src/v2/gen/types.gen.ts:3408` are generated SDK session surfaces that must be regenerated if session shapes change.

## Non-Negotiables

- Must not compute displayed time from `session.time.created`.
- Must not include user idle time between prompts.
- Must not add tool execution timing or permission/question wait timing in the first pass.
- Must persist cumulative AI processing time so `session.get`, `session.list`, TUI sync, and v2 session list all agree.
- Must store duration in milliseconds as a non-negative integer.
- Must default existing sessions to `0` processing milliseconds.
- Must not backfill historical sessions in the first pass.
- Must keep existing cost/token accumulation behavior unchanged.
- Must keep the prompt footer order: AI processing time, usage, agent/commands hints.
- Must regenerate the JS SDK after changing API-visible schemas.

## Data Model

Add a session table column:

```ts
time_processing: integer().notNull().default(0)
```

Expose it as a duration, not a timestamp:

```ts
type SessionTime = {
  created: number
  updated: number
  compacting?: number
  archived?: number
  processing: number
}
```

For v2 sessions, keep timestamp fields as `DateTimeUtcFromMillis`, but expose processing as milliseconds:

```ts
time: {
  created: DateTime.Utc
  updated: DateTime.Utc
  archived?: DateTime.Utc
  processing: number
}
```

Update these mappings:

- `packages/opencode/src/session/session.sql.ts`
- `packages/opencode/src/session/session.ts` `fromRow`
- `packages/opencode/src/session/session.ts` `toRow`
- `packages/opencode/src/session/session.ts` `Time`
- `packages/opencode/src/session/projectors.ts` `toPartialRow`
- `packages/opencode/src/v2/session.ts` `Info`
- `packages/opencode/src/v2/session.ts` row-to-info mapping

## Measurement

Add an optional processing duration to `step-finish` parts:

```ts
type StepFinishPart = {
  type: "step-finish"
  reason: string
  snapshot?: string
  cost: number
  tokens: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  duration?: number
}
```

Behavior:

- `duration` is milliseconds spent between the corresponding LLM step start and step finish.
- New `step-finish` parts must include `duration`.
- Existing persisted `step-finish` parts without `duration` must count as `0`.
- Negative or non-finite measured durations must be clamped to `0`.
- Failed, aborted, or incomplete steps must not add processing time unless a valid `step-finish` part is emitted.
- If multiple LLM steps occur in one assistant response, each finished step contributes to the session total.

Recommended implementation:

- Add `currentStepStarted` to `ProcessorContext` in `packages/opencode/src/session/processor.ts`.
- On `start-step`, set `currentStepStarted = Date.now()` before emitting the `step-start` part.
- On `finish-step`, compute `duration = Math.max(0, Date.now() - currentStepStarted)` when available.
- Reset `currentStepStarted` after `finish-step` and on failed/aborted cleanup paths.
- Add `duration` to the `step-finish` part emitted at `packages/opencode/src/session/processor.ts:516`.

## Accumulation

Extend the existing usage projector instead of recomputing duration in the TUI.

Update `packages/opencode/src/session/projectors.ts`:

- Extend `Usage` to include `duration`.
- Update `usage()` so only `step-finish` parts contribute.
- Default missing `duration` to `0`.
- Update `applyUsage()` to also accumulate `SessionTable.time_processing`.
- Preserve the existing subtract-previous/add-next behavior for part updates and removals.

Expected accumulation behavior:

```ts
time_processing = time_processing + duration * sign
```

This keeps duration semantics aligned with cost and tokens:

- Adding a new `step-finish` increments processing time.
- Removing a `step-finish` decrements processing time.
- Updating a `step-finish` subtracts the old duration and adds the new duration.

## TUI Behavior

Replace the wall-clock elapsed display with persisted AI processing time.

Update `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`:

- Remove the `now` signal and one-second timer used only for wall-clock elapsed time.
- Replace `elapsed()` with a memo that reads `sync.session.get(props.sessionID)?.time.processing`.
- Format with `formatDuration(Math.floor(processingMs / 1000)) || "0s"`.
- Render as `AI <duration>` to avoid implying wall-clock session age.
- Hide only when session data is unavailable.
- Show `AI 0s` for sessions that exist but have no completed AI processing yet.

Footer example:

```text
AI 1m 12s  22,104 tokens · $0.05  Ctrl+P commands
```

## Migration

Generate a migration from `packages/opencode`:

```sh
bun run db generate --name session_processing_time
```

The migration must:

- Add `time_processing integer not null default 0` to `session`.
- Not backfill from historical parts.
- Leave existing sessions readable.

## Implementation Slices

### PR 1: Persist Processing Time

- Add `time_processing` to `SessionTable`.
- Generate the database migration.
- Add `time.processing` to `Session.Info`.
- Update `fromRow`, `toRow`, `toPartialRow`, and schema tests.
- Add optional `duration` to `MessageV2.StepFinishPart`.
- Update `SessionProcessor` to measure step duration and write it to new `step-finish` parts.
- Extend `applyUsage` to accumulate `time_processing`.

Verification:

- `cd packages/opencode && bun test test/session/session.test.ts test/session/session-schema.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Check that duration accumulation mirrors cost/token accumulation and that existing stored parts without `duration` remain valid.

### PR 2: Expose Through APIs And SDK

- Add `time.processing` to `SessionV2.Info`.
- Ensure legacy `session.get`, `session.list`, and `session.children` responses include `time.processing` through `Session.Info`.
- Ensure v2 `/api/session` responses include `time.processing`.
- Add focused HTTP API coverage for `time.processing` defaulting to `0` and increasing after a persisted step finish.
- Regenerate the JavaScript SDK.

Verification:

- `cd packages/opencode && bun test test/server/httpapi-session.test.ts test/server/session-list.test.ts`
- `cd packages/opencode && bun typecheck`
- `./packages/sdk/js/script/build.ts`

Review:

Check generated SDK diffs only reflect schema changes from `time.processing` and optional step-finish `duration`.

### PR 3: Switch TUI Footer Display

- Update `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` to render `AI <duration>` from `session.time.processing`.
- Remove the wall-clock timer used for elapsed session age.
- Keep token/cost and command shortcut rendering unchanged.
- Update or replace `packages/opencode/specs/tui-prompt-footer-elapsed-time.md` so it no longer describes wall-clock elapsed behavior.

Verification:

- `cd packages/opencode && bun typecheck`

Review:

Confirm the footer no longer changes while the user is idle and no longer derives timing from `time.created`.

## Future Work

- Backfill historical sessions from persisted `step-start` and `step-finish` part timestamps if users need historical accuracy.
- Add live in-flight ticking for the current active LLM step by exposing an active processing start timestamp, without using broad `SessionStatus.busy`.
- Add separate metrics for tool execution time if users want agent runtime split by LLM, tools, and waiting.
- Add a config option to hide AI processing time from the footer.
