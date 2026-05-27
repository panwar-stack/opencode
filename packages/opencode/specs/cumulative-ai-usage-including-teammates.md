# Cumulative AI Usage Including Teammates

## Goal

Update the AI processing time and token consumed feature so it can show both lead-session usage and cumulative usage across the lead session plus teammate sessions.

The implementation must preserve the original lead-session AI time and token values, then add a separate cumulative rollup that includes registered teammates. Reuse existing persisted session aggregates instead of recalculating from assistant messages.

## Current State

- `packages/opencode/src/session/session.sql.ts` persists aggregate usage on `SessionTable`: `cost`, token columns, and `time_processing`.
- `packages/opencode/src/session/session.ts` exposes `Session.Info.cost`, `Session.Info.tokens`, and `Session.Info.time.processing`.
- `packages/opencode/src/session/projectors.ts` projects `step-finish` parts into `SessionTable` and safely adds/subtracts aggregate usage.
- `packages/opencode/src/session/processor.ts` emits `step-finish` parts with `cost`, `tokens`, and `duration`.
- `packages/opencode/src/team/team.sql.ts` stores `TeamTable.lead_session_id` and `TeamMemberTable.session_id`.
- `packages/opencode/src/tool/team_spawn.ts` creates teammate sessions and records them in `TeamMemberTable`.
- `packages/opencode/src/tool/team_report.ts` already sums lead + teammate session rows, but reports wall runtime instead of AI processing time.
- `packages/app/src/context/directory-sync.ts` and `packages/app/src/context/global-sync/event-reducer.ts` already sync `Session.Info`.
- `packages/app/src/components/session-context-usage.tsx`, `packages/app/src/components/session/session-context-tab.tsx`, and `packages/app/src/components/session/session-context-metrics.ts` currently derive most visible usage from messages, not session aggregate rows.

## Non-Negotiables

- Must keep lead-session AI processing time and tokens separate from cumulative values.
- Must use `SessionTable` / `Session.Info` aggregate values for consumed tokens and AI processing time.
- Must not replace context-window token math in `getSessionContextMetrics`.
- Must include only registered teammates from `TeamMemberTable` in the first pass.
- Must not recursively include arbitrary `SessionTable.parent_id` children unless they are team members.
- Must handle no-team sessions by returning cumulative values equal to lead values.
- Must avoid schema migrations.
- Cost may be returned for parity with existing aggregates, but time and tokens are the required display fields.
- Must regenerate SDK clients if HTTP schemas change.

## Data Model And API Surface

Add an opt-in HTTP endpoint instead of expanding every `Session.Info` payload.

Recommended route:

```ts
SessionPaths.usage = `${root}/:sessionID/usage`
```

Recommended response schema:

```ts
type SessionUsageRollup = {
  lead: {
    sessionID: string
    cost: number
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
    time: { processing: number }
  }
  cumulative: {
    cost: number
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
    time: { processing: number }
    sessionIDs: string[]
  }
}
```

Implementation rules:

- Define the response as an Effect schema near `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`.
- Add `session.usage({ sessionID }) -> SessionUsageRollup`.
- If `sessionID` is a lead session, use it as `lead.sessionID`.
- If `sessionID` belongs to `TeamMemberTable.session_id`, resolve its team and use `TeamTable.lead_session_id` as `lead.sessionID`.
- Sum all registered team member sessions for the resolved lead session across `TeamTable.lead_session_id = lead.sessionID`.
- De-dupe session IDs.
- Return `cumulative.sessionIDs` with the lead first, then teammate session IDs ordered by `TeamMemberTable.time_created`, then `session_id`.
- If a teammate row references a missing session row, skip that member row rather than failing the whole rollup.
- If the requested session does not exist and is not a team member session, match existing `session.get` not-found behavior.

## UI Behavior

- Lead consumed values must come from `sync.session.get(params.id)?.tokens`, `cost`, and `time.processing`.
- Context-window values must continue to come from `getSessionContextMetrics`.
- Add cumulative values from `session.usage`.
- Use explicit labels such as `Lead AI time`, `Lead tokens`, `Total AI time`, and `Total tokens`.
- Use token total formula: `input + output + reasoning + cache.read + cache.write`.
- Convert `time.processing` milliseconds with existing app duration formatting utilities.
- Before rollup data loads, show existing lead values and omit cumulative rows rather than showing zero.

## Implementation Slices

### PR 1: Backend Rollup Endpoint

- Add a rollup helper that reads `SessionTable`, `TeamTable`, and `TeamMemberTable`.
- Add `GET /session/:sessionID/usage` to the session HTTP API group and handler.
- Add an Effect schema for `SessionUsageRollup`.
- Add focused tests for no team, two teammates, teammate-session resolution, de-duped deterministic ordering, missing teammate session rows, multiple historical teams for one lead, and missing requested session.
- Regenerate the JavaScript SDK.

Verification:

- `cd packages/opencode && bun test test/server/httpapi-session.test.ts`
- `cd packages/opencode && bun typecheck`
- `cd /Users/srpanwar/Documents/Workspace/brain/opencode && ./packages/sdk/js/script/build.ts`

Review:

Before merging, a fresh read-only reviewer must confirm the diff uses existing aggregate columns, adds no persistence, preserves lead values, and does not include non-team child sessions.

### PR 2: App Fetch And Metrics Plumbing

- Add app-side client usage for `session.usage`.
- Store rollups in a `sessionUsageRollup[sessionID]` cache or equivalent session-local state.
- Fetch rollup on session load or context tab open.
- Refetch or invalidate rollup when `session.updated` arrives for the lead session or a known `cumulative.sessionIDs` member.
- Add a small metrics helper for display token totals without changing `getSessionContextMetrics`.
- Add tests for token total math, including reasoning and cache read/write tokens.

Verification:

- `cd packages/app && bun test src/components/session/session-context-metrics.test.ts`
- `cd packages/app && bun typecheck`

Review:

Before merging, a fresh read-only reviewer must confirm UI plumbing keeps lead and cumulative values separate and does not change context-window progress behavior.

### PR 3: Usage Display Updates

- Update `packages/app/src/components/session/session-context-tab.tsx` to show lead and total AI processing time.
- Update the same view to show lead and total tokens consumed.
- Optionally add tooltip rows in `packages/app/src/components/session-context-usage.tsx`, but keep the progress bar based on latest-context usage.
- Use labels that clearly communicate scope: `Lead` for current/lead session only and `Total` or `Including teammates` for cumulative.
- Update component tests if matching coverage already exists.

Verification:

- `cd packages/app && bun test src/components/session/session-context-metrics.test.ts`
- `cd packages/app && bun typecheck`

Review:

Before merging, a fresh read-only reviewer must confirm users cannot mistake cumulative usage as replacing lead-session usage, and that missing rollup data is omitted or clearly loading.

## Future Work

- Include non-team child sessions by `SessionTable.parent_id` if product scope expands beyond teammates.
- Add cumulative usage to ACP, CLI, or TUI surfaces.
- Add cached rollup columns only if live summation becomes a measured performance issue.
- Extend `team_report` to report AI processing time separately from wall runtime.

## Open Questions

- Should compact tooltip totals be included in PR 3? Default: keep cumulative totals in the context tab first.
- Should cost be displayed in UI alongside time and tokens? Default: return cost from the API but do not add new cost UI unless it fits the existing usage section.
