# OpenGrep Search Tool

## Goal

Add an optional `opengrep` tool that appears when the `opengrep` binary is available, downloading it into the opencode bin directory when missing. The tool gives agents a semantic/code-pattern search path without replacing existing `grep` and `glob` ripgrep-backed tools.

Implementation should be incremental: first add binary detection and registry gating, then add the executable tool surface, then update docs/types.

## Current State

- `packages/opencode/src/tool/grep.ts` defines the current content search tool using `Ripgrep.Service.search`.
- `packages/opencode/src/tool/glob.ts` defines file pattern search using `Ripgrep.Service.files`.
- `packages/opencode/src/file/ripgrep.ts` locates or downloads `rg`; `opengrep` should follow the same local-binary-first, download-if-missing model.
- `packages/opencode/src/util/which.ts` already checks binaries on `PATH` and `Global.Path.bin`.
- `packages/opencode/src/tool/registry.ts` registers built-in tools and already supports conditional tool visibility for websearch, memory, repo, LSP, team, and plan tools.
- `packages/opencode/src/config/permission.ts` has explicit permission keys for `grep` and `glob`, while also accepting unknown keys through a rest schema.
- Public tool docs live in `packages/web/src/content/docs/tools.mdx`.
- Permission docs live in `packages/web/src/content/docs/permissions.mdx`.
- Active specs live under `packages/opencode/specs/*.md`; save this as `packages/opencode/specs/opengrep-search-tool.md` if persisted.

## Non-Negotiables

- `opengrep` must be hidden from `/experimental/tool/ids`, prompts, and registry output only when the binary cannot be found or downloaded.
- If `opengrep` is missing, download it into `Global.Path.bin` using the same ownership model as ripgrep. Do not vendor it into source control.
- Do not replace or change `grep`/`glob` behavior.
- Do not accept arbitrary shell fragments. Build the command with structured args only.
- Search paths must use the same session/root-aware path handling and external directory permission checks as `grep`.
- Tool output must be bounded: default to 100 findings and truncate long snippets consistently with `grep`.
- First pass supports direct search only. Leave autofix, SARIF, rule packs, ignore-file customization, and persistent config out of scope.

## Tool Surface

Add a built-in tool id: `opengrep`.

Suggested parameters:

```ts
{
  pattern: string
  language?: string
  path?: string
  include?: string
  exclude?: string
}
```

Behavior:

- `pattern` is the OpenGrep/Semgrep-compatible pattern to search for.
- `language` defaults to `generic`.
- `path` defaults to the current session root.
- `include` and `exclude` are optional glob filters passed as structured OpenGrep args when supported.
- The tool creates an ephemeral rule config rather than accepting arbitrary config paths.
- The tool runs OpenGrep in JSON mode and maps findings into stable output:

```ts
{
  file: string
  line: number
  column?: number
  message?: string
  match: string
}
```

Failure modes:

- If the binary disappears between registry detection and execution and cannot be downloaded again, return a clear tool error: `opengrep is not installed or could not be downloaded`.
- If OpenGrep exits with "no findings", return an empty result, not an error.
- If OpenGrep returns invalid JSON, return a concise parse error with stderr included only after truncation.
- If `path` is outside allowed roots, follow existing external-directory permission behavior.

## Implementation Slices

### PR 1: Binary Detection, Download, And Registry Gating

- Add `packages/opencode/src/file/opengrep.ts` with an `Opengrep.Service` that exposes:
  - `path(): Effect<string>` returning an existing binary path or downloading the binary when missing.
  - `available(): Effect<boolean>`
  - later executable methods can be added in PR 2.
- Use `packages/opencode/src/util/which.ts` to prefer a local `opengrep` on `PATH` or in `Global.Path.bin` before downloading.
- Download `opengrep` into `Global.Path.bin` when it is missing, mirroring the ripgrep flow in `packages/opencode/src/file/ripgrep.ts`.
- Update `packages/opencode/src/tool/registry.ts` to include `opengrep` only when `Opengrep.Service.available()` is true after detection/download.
- Add registry tests in `packages/opencode/test/tool/registry.test.ts`:
  - hides `opengrep` when unavailable and download fails or is unsupported.
  - shows `opengrep` when an existing binary is found.
  - shows `opengrep` when a missing binary is downloaded successfully.

Verification:

- `cd packages/opencode && bun test test/tool/registry.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Before merge, a fresh read-only reviewer must compare the diff against this slice and verify no execution behavior or docs were added prematurely.

### PR 2: Search Execution Tool

- Add `packages/opencode/src/tool/opengrep.ts`.
- Add `packages/opencode/src/tool/opengrep.txt`.
- Implement `Tool.define("opengrep", ...)` with permission id `opengrep`.
- Reuse path resolution patterns from `packages/opencode/src/tool/grep.ts`.
- Add execution support to `packages/opencode/src/file/opengrep.ts`.
- Add `packages/opencode/test/tool/opengrep.test.ts` covering:
  - command args are structured, not shell-concatenated.
  - no findings returns empty output.
  - findings are mapped to stable file/line/match output.
  - path handling matches `grep` for workspace roots and external directories.
  - unavailable binary and failed download produce a clear error if execution is attempted.

Verification:

- `cd packages/opencode && bun test test/tool/opengrep.test.ts`
- `cd packages/opencode && bun test test/tool/grep.test.ts test/tool/glob.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Before merge, a fresh read-only reviewer must inspect command construction, path validation, output bounding, and failure-mode behavior.

### PR 3: Permissions, SDK, And Docs

- Add explicit `opengrep: Schema.optional(Rule)` to `packages/opencode/src/config/permission.ts`.
- Regenerate the JS SDK because config schema/types changed:
  - `./packages/sdk/js/script/build.ts`
- Update `packages/web/src/content/docs/tools.mdx` with the optional `opengrep` tool.
- Update `packages/web/src/content/docs/permissions.mdx` with the `opengrep` permission key.
- Update `packages/opencode/specs/effect/tools.md` if the built-in tool list is kept current there.
- Leave translated docs for a follow-up unless the repo requires same-PR translation updates.

Verification:

- `./packages/sdk/js/script/build.ts`
- `cd packages/opencode && bun typecheck`
- `cd packages/sdk/js && bun typecheck`
- `cd packages/web && bun run build`

Review:

Before merge, a fresh read-only reviewer must verify generated SDK files are produced by the build script, docs match actual tool availability, and no hand-written generated output is present.

## Future Work

- Support `semgrep` as a fallback binary only if explicitly requested.
- Add config for default language, include/exclude globs, or custom rule packs.
- Add SARIF output or richer structured diagnostics.
- Add autofix support as a separate permissioned tool.

## Open Questions

- Should `semgrep` be accepted as a fallback binary? Default recommendation: no, only detect or download `opengrep` to match the requirement exactly.
- Should `language` default to `generic`? Default recommendation: yes, because it keeps the first-pass tool usable without adding a large language enum.
