# Remove GitHub Review Memory

## Goal

Remove the existing GitHub review-memory system from opencode: no indexing CLI, no GitHub review comment storage, no automatic system-prompt injection, no built-in `review-memory` skill, and no public config/API/SDK surface for `memory`.

Implement this as small removal slices so each PR is reviewable and typecheckable.

## Current State

- `packages/opencode/src/cli/cmd/memory.ts` implements `opencode memory`, including `index github`, `query`, and `review`.
- `packages/opencode/src/index.ts` imports and registers `MemoryCommand`.
- `packages/opencode/src/memory/github.ts` indexes GitHub PR review comments through `gh api`.
- `packages/opencode/src/memory/repo.ts`, `search.ts`, and `memory.sql.ts` implement the SQLite-backed memory index.
- `packages/opencode/src/session/prompt.ts` injects historical review memory into the system prompt.
- `packages/opencode/src/skill/index.ts` registers built-in skill `review-memory`.
- `packages/opencode/src/skill/prompt/review-memory.md` contains the built-in skill instructions.
- `packages/opencode/src/config/memory.ts` defines `memory.enabled`, `memory.limit`, and GitHub provider config.
- `packages/opencode/src/config/config.ts` exposes `memory?: ConfigMemory.Info`.
- `/config` and `/global/config` expose `Config.Info`, so `memory` appears in OpenAPI and generated SDK types.
- `packages/opencode/migration/20260516073015_review_memory/migration.sql` creates memory tables.
- `packages/sdk/openapi.json` and `packages/sdk/js/src/v2/gen/types.gen.ts` expose `MemoryConfig`.
- Tests exist under `packages/opencode/test/cli/memory.test.ts`, `test/memory/*.test.ts`, `test/session/prompt.test.ts`, `test/config/config.test.ts`, `test/command/command.test.ts`, `test/tool/skill.test.ts`, and `test/skill/skill.test.ts`.
- Docs/specs mention the feature in `README.md`, `Why.md`, and `packages/opencode/specs/*review-memory*.md`.

## Non-Negotiables

- Remove the GitHub review-memory behavior, not just hide it from docs.
- Do not call `gh api` for review-memory indexing after removal.
- Do not inject historical review memory into session prompts.
- Do not leave `opencode memory` registered.
- Do not expose `memory` in config OpenAPI or generated SDK types.
- Do not edit historical migration files; add a forward migration that drops memory tables.
- Leave unrelated memory concepts out of scope unless they are part of this GitHub review-memory implementation.

## Removal Behavior

- `opencode memory` must no longer be a valid command.
- Built-in skill lookup for `review-memory` must fail the same way any unknown built-in skill fails.
- Session prompt generation must not query memory storage or include text beginning with `Historical review memory`.
- Config responses from `/config` and `/global/config` must not include `memory`.
- Generated SDK types must not export `MemoryConfig`.

## Implementation Slices

### PR 1: Remove Runtime Entry Points

- Remove `MemoryCommand` import and yargs registration from `packages/opencode/src/index.ts`.
- Delete `packages/opencode/src/cli/cmd/memory.ts`.
- Remove review-memory prompt injection from `packages/opencode/src/session/prompt.ts`.
- Remove `Memory.defaultLayer` from `packages/opencode/src/effect/app-runtime.ts`.
- Remove built-in `review-memory` registration from `packages/opencode/src/skill/index.ts`.
- Delete `packages/opencode/src/skill/prompt/review-memory.md`.
- Remove or update tests that assert CLI, prompt, command, tool, or skill exposure.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test test/session/prompt.test.ts test/command/command.test.ts test/tool/skill.test.ts test/skill/skill.test.ts`

Review:

Confirm there is no registered `opencode memory` command, no `review-memory` built-in skill, and no review-memory text in generated session prompts.

### PR 2: Remove Config And SDK Surface

- Delete `packages/opencode/src/config/memory.ts`.
- Remove `ConfigMemory` import and `memory` field from `packages/opencode/src/config/config.ts`.
- Update config tests in `packages/opencode/test/config/config.test.ts`.
- Regenerate OpenAPI and JS SDK output.
- Remove `MemoryConfig` and `Config.memory` from `packages/sdk/openapi.json`.
- Remove generated `MemoryConfig` references from `packages/sdk/js/src/v2/gen/types.gen.ts` and generated dist files.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test test/config/config.test.ts`
- `./packages/sdk/js/script/build.ts`
- `cd packages/sdk/js && bun typecheck`

Review:

Confirm `/config` and `/global/config` schemas no longer expose `memory`, and generated SDK types no longer export `MemoryConfig`.

### PR 3: Remove Storage, Service Code, And Tests

- Delete `packages/opencode/src/memory/index.ts`.
- Delete `packages/opencode/src/memory/github.ts`.
- Delete `packages/opencode/src/memory/repo.ts`.
- Delete `packages/opencode/src/memory/search.ts`.
- Delete `packages/opencode/src/memory/memory.sql.ts`.
- Generate a new migration named `remove_review_memory` that drops:
- `memory_repository`
- `memory_source_item`
- `memory_constraint`
- `memory_constraint_source`
- `memory_citation`
- `memory_sync_checkpoint`
- Delete `packages/opencode/test/cli/memory.test.ts`.
- Delete `packages/opencode/test/memory/index.test.ts`.
- Delete `packages/opencode/test/memory/github.test.ts`.

Verification:

- `cd packages/opencode && bun run db generate --name remove_review_memory`
- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test`

Review:

Confirm the new migration is forward-only and historical migrations are unchanged.

### PR 4: Remove Docs And Historical Feature References

- Remove the `Historical Review Memory` section from `README.md`.
- Remove review-memory mentions from `Why.md`.
- Delete or mark obsolete:
- `packages/opencode/specs/native-review-memory-cli.md`
- `packages/opencode/specs/github-pr-review-memory.md`
- `packages/opencode/specs/github-closed-pr-review-memory.md`
- Run a repository search for stale active references.

Verification:

- `rg "review-memory|review memory|Historical review memory|MemoryConfig|MemoryGithub|MemoryIndex|opencode memory|memory_repository|memory_source_item|memory_constraint" .`

Review:

Allow matches only in historical migration files or intentionally retained obsolete specs, if the team chooses to keep them.

## Open Questions

- Should existing user configs containing `memory` be rejected or ignored? Default recommendation: remove schema support and let the current config validation behavior apply, with no compatibility shim.
- Should old review-memory spec files be deleted or marked obsolete? Default recommendation: delete them unless the team wants specs to serve as historical design records.
