# Multi-Root Sessions

## Goal

Add first-class support for one opencode session to know and work across multiple working directories. The first pass should keep one default root for compatibility, then allow users to add, list, remove, and target additional roots during the same session.

Repo scan found no existing first-class multi-working-directory session support. Current behavior supports some ad hoc absolute paths and shell `workdir`, but session storage, tool defaults, permissions, snapshots, LSP, and TUI display are anchored to one `directory`.

## Current State

- `packages/opencode/src/session/session.sql.ts:16-29` stores one `session.directory`, one `project_id`, optional `workspace_id`, and optional `path`.
- `packages/opencode/src/session/session.ts:210-229` exposes `Session.Info.directory: string` and `path?: string`.
- `packages/opencode/src/session/session.ts:661-680` creates sessions from the current `InstanceState.context.directory`.
- `packages/opencode/src/project/instance-context.ts:5-9` models one `InstanceContext` with `{ directory, worktree, project }`.
- `packages/opencode/src/tool/shell.ts:614-618` defaults shell cwd to `instanceCtx.directory`; `workdir` is only per-call.
- `packages/opencode/src/tool/read.ts:200-208`, `write.ts:40-44`, `edit.ts:79-83`, and `apply_patch.ts:55-75` resolve relative paths against one `instance.directory`.
- `packages/opencode/src/tool/external-directory.ts:16-45` treats paths outside the current instance/worktree as external.
- `packages/opencode/src/snapshot/index.ts:76-85` stores one snapshot `directory/worktree`.
- `packages/opencode/src/lsp/lsp.ts:214-243` routes files through one instance directory.
- Slash commands are local keymap/palette entries: `packages/opencode/src/cli/cmd/tui/context/command-palette.tsx:61-80`.
- Session slash commands are declared in `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:475-733` and mapped to keymap entries at `1137-1145`.
- The TUI footer currently shows one directory via `packages/opencode/src/cli/cmd/tui/routes/session/footer.tsx:20-54`.
- `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:46-54` allows session updates for title, permission, and archive time only.
- SDK-facing types will need regeneration if the API exposes roots. Regeneration command: `./packages/sdk/js/script/build.ts`.

## Non-Negotiables

- Existing sessions must continue to load with their current single `directory`.
- New sessions must start with exactly one default root matching today’s `session.directory`.
- Do not remove or rename `session.directory` in the first pass; keep it as the compatibility/default root.
- Registered roots must be absolute, normalized paths.
- Tools must not silently treat unregistered external paths as trusted roots.
- Permission prompts must remain explicit when a path is outside every registered root.
- Leave cross-root atomic git operations, multi-repo branch management, and remote workspace sync enhancements out of the first pass.

## Data Model

Add a session root model while preserving the existing scalar directory.

```ts
type SessionRoot = {
  id: string
  sessionID: string
  name?: string
  directory: string
  worktree: string
  projectID: string
  path?: string
  created: number
  primary: boolean
}
```

Storage shape:

- Add `session_root` table in `packages/opencode/src/session/session.sql.ts`.
- Columns should use snake_case:
- `id`
- `session_id`
- `name`
- `directory`
- `worktree`
- `project_id`
- `path`
- `created`
- `primary`
- Backfill one primary root for every existing session from `session.directory`, `session.project_id`, and `session.path`.
- Enforce uniqueness on `(session_id, directory)`.
- Keep `session.directory` synchronized with the primary root for compatibility.

## API Surface

Add small session-root endpoints instead of overloading generic `session.update`.

```ts
GET /session/:sessionID/root
POST /session/:sessionID/root
PATCH /session/:sessionID/root/:rootID
DELETE /session/:sessionID/root/:rootID
```

Payloads:

```ts
type AddSessionRootPayload = {
  directory: string
  name?: string
}

type UpdateSessionRootPayload = {
  name?: string
  primary?: boolean
}
```

Behavior:

- `POST` resolves the directory through existing project discovery so each root has its own `worktree` and `projectID`.
- `POST` rejects duplicates for the same session.
- `PATCH primary: true` updates the default root and synchronizes `session.directory`.
- `DELETE` rejects deleting the last root.
- `DELETE` of the primary root requires another root to become primary, either by explicit prior `PATCH` or deterministic fallback to the oldest remaining root.
- SDK must expose the new root types and endpoints.

## Tool Behavior

First pass should support root-aware execution without changing every tool schema.

- Relative paths continue to resolve against the primary root by default.
- Absolute paths inside any registered root are treated as in-session paths, not `external_directory`.
- Absolute paths outside all registered roots keep today’s external-directory permission flow.
- Shell `workdir` may target any registered root or subdirectory under one.
- Glob/grep `path` may target any registered root or subdirectory under one.
- Read/edit/write/apply_patch should map absolute paths to their containing registered root for permission labels and relative display.
- Prompt context should list registered roots so the model knows they are available.

Future root selector parameters can be added later if model behavior shows ambiguity.

## TUI Behavior

Best first-pass UX:

- Add `/roots` as the primary session command.
- `/roots` opens a dialog listing roots with name, shortened path, primary marker, and actions.
- Dialog actions:
- Add root
- Rename root
- Make primary
- Remove root
- Add aliases `/cwd` and `/dirs` for discoverability.
- Do not implement slash arguments in the first pass because current local slash commands invoke dialogs/toggles, not parsed argument handlers.
- Footer should show the primary directory and root count, for example `/repo-a +2 roots`.
- When a root is added, append a system reminder to the session context: `The session can now work in another directory: <name or path> at <absolute path>.`

## Implementation Slices

### PR 1: Storage And API

- Add `session_root` schema and migration under `packages/opencode/migration`.
- Backfill one primary root per existing session.
- Add session service methods: list roots, add root, update root, remove root, get primary root.
- Add HTTP API endpoints and schemas for session roots.
- Keep `session.directory` synchronized with the primary root.
- Add unit tests for migration/backfill and root CRUD.

Verification:

- `cd packages/opencode && bun run db generate --name session_roots`
- `cd packages/opencode && bun test src/session`
- `cd packages/opencode && bun typecheck`

Review:

Focus on migration safety, compatibility with existing session list/filter behavior, duplicate handling, and last-root deletion behavior.

### PR 2: Root-Aware Tool Boundaries

- Add shared root resolution helper for session paths.
- Update external-directory checks to accept paths inside any registered root.
- Update shell, glob, grep, read, write, edit, and apply_patch path resolution to identify the containing root for absolute paths.
- Keep relative path behavior anchored to the primary root.
- Add tests for registered root access and unregistered external path prompts.

Verification:

- `cd packages/opencode && bun test src/tool`
- `cd packages/opencode && bun typecheck`

Review:

Focus on permission regressions, path normalization, symlink edge cases, and ensuring unregistered paths still prompt.

### PR 3: TUI Root Management

- Add `/roots` session command in `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`.
- Add a roots dialog for list/add/rename/make-primary/remove.
- Update footer display in `packages/opencode/src/cli/cmd/tui/routes/session/footer.tsx`.
- Add root count and primary root to synced session state if needed.
- Show success/error toasts for root mutations.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test src/cli/cmd/tui`

Review:

Focus on discoverability, low cognitive load, keyboard-only flow, and clear destructive confirmation for remove.

### PR 4: Prompt Context, Snapshots, LSP, SDK

- Include session roots in prompt/session context.
- Update snapshot handling to track per-root diffs or explicitly scope snapshots to the primary root with documented limitation.
- Route LSP/file ownership by containing registered root where feasible.
- Regenerate JavaScript SDK after API changes.
- Add tests for SDK type generation if existing SDK checks cover generated output.

Verification:

- `./packages/sdk/js/script/build.ts`
- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test src/snapshot src/lsp`

Review:

Focus on model-visible root context, snapshot correctness, generated SDK diffs, and any remaining primary-root-only limitations.

## Future Work

- Slash argument support such as `/root add ../other-repo`.
- Per-message or per-tool explicit `rootID` selection.
- Cross-root batch status in the footer/sidebar.
- Workspace sync support for multi-root remote sessions.
- Cross-repository git summary and branch/status display.
- Auto-detect sibling package roots in monorepos.

## Open Questions

- Should root names be required? Default recommendation: no. Generate display names from basename and allow optional rename.
- Should relative paths ever resolve by root name prefixes like `api/src/index.ts`? Default recommendation: no in first pass; require absolute paths or primary-root-relative paths to avoid ambiguity.
- Should snapshots cover all roots in PR 2 or later? Default recommendation: later unless tool permission work makes per-root snapshotting straightforward.
