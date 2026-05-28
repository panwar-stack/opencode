# Docker Execution Sandboxing

## Goal

Add real runtime isolation for built-in shell execution, separate from permission prompts. Permissions still decide whether a command may be attempted; sandboxing controls where and how the approved command runs.

First pass should sandbox `ShellTool`/`bash` execution through Docker, using the provided `sandbox` config shape as the starting point. Keep the integration narrow: preserve existing command permission prompts, timeout/cancellation behavior, output handling, and `workdir` semantics while adding filesystem, network, process, and resource isolation.

## Current State

- `packages/opencode/src/tool/shell.ts` owns built-in shell execution through `ShellTool`.
- `ShellTool.execute()` resolves `workdir`, scans command permissions, asks `external_directory` and `bash` permissions, then calls `run(...)`.
- `packages/opencode/src/tool/shell.ts` `cmd(...)` is the narrowest sandbox insertion point because it builds the `ChildProcess.make(...)` command used by `run(...)`.
- `packages/core/src/cross-spawn-spawner.ts` handles lower-level process spawning, env extension, detached process groups, and kill escalation.
- `packages/opencode/src/config/config.ts` defines `Config.Info`; adding `sandbox` there affects config API/OpenAPI and SDK types.
- `packages/opencode/src/config/permission.ts` defines permission keys and actions. Sandbox config must not be modeled as a permission action.
- `packages/opencode/src/permission/index.ts` provides approval flow for `ask | allow | deny`.
- `packages/opencode/src/pty/index.ts` is a separate terminal execution path and should stay out of first pass.
- Existing “sandbox” naming in `packages/opencode/src/project/project.ts` means project/worktree sandbox, not process isolation.
- Docs likely needing updates: `packages/web/src/content/docs/config.mdx`, `packages/web/src/content/docs/permissions.mdx`, `packages/web/src/content/docs/tools.mdx`, `packages/web/src/content/docs/plugins.mdx`.

## Non-Negotiables

- Sandbox execution must be separate from permission prompts.
- Existing `bash` and `external_directory` permission checks must run before sandbox execution.
- `sandbox.enabled: false` or missing config must preserve current host execution behavior.
- First pass must apply only to built-in `ShellTool`; do not sandbox PTY, MCP tools, custom tools, plugin hooks, or internal maintenance commands.
- Docker unavailability must produce a clear shell tool error, not silently fall back to unsandboxed execution when `sandbox.enabled` is true.
- Timeouts and aborts must still kill the full process tree/container.
- Network mode `full` with `requiresApproval: true` must request approval before running the command with full network access.
- Allowlist networking must be real enforcement. Do not document host allowlists unless implementation blocks non-allowlisted egress.
- Config/schema changes that affect OpenAPI must regenerate the JS SDK with `./packages/sdk/js/script/build.ts`.

## Config

Add `sandbox` to `Config.Info` in `packages/opencode/src/config/config.ts`.

```ts
{
  sandbox?: {
    enabled?: boolean
    defaultProfile?: string
    profiles?: Record<string, SandboxProfile>
  }
}

type SandboxProfile = {
  filesystem?: {
    read?: SandboxPathToken[]
    write?: SandboxPathToken[]
    protected?: SandboxPathToken[]
  }
  network?: SandboxNetwork
  process?: {
    hideHostProcesses?: boolean
    killTreeOnExit?: boolean
  }
  resources?: {
    memoryMegabytes?: number
    processLimit?: number
    timeSeconds?: number
  }
}

type SandboxNetwork =
  | { mode: "none" }
  | { mode: "allowlist"; hosts: string[] }
  | { mode: "full"; requiresApproval?: boolean }

type SandboxPathToken =
  | "workspace"
  | "systemRuntime"
  | "temporaryDirectory"
  | `workspace/${string}`
  | `home/${string}`
```

Default behavior:

- Missing `sandbox` means disabled.
- `sandbox.enabled: true` uses `sandbox.defaultProfile`.
- Missing `defaultProfile` defaults to `workspace`.
- Unknown profile name fails config validation.
- First pass should support this profile shape:

```json
{
  "sandbox": {
    "enabled": true,
    "defaultProfile": "workspace",
    "profiles": {
      "workspace": {
        "filesystem": {
          "read": ["workspace", "systemRuntime"],
          "write": ["workspace", "temporaryDirectory"],
          "protected": [
            "workspace/.git/hooks",
            "workspace/.opencode",
            "workspace/AGENTS.md",
            "home/.ssh",
            "home/.config",
            "home/.aws",
            "home/.gitconfig"
          ]
        },
        "network": {
          "mode": "none"
        },
        "process": {
          "hideHostProcesses": true,
          "killTreeOnExit": true
        },
        "resources": {
          "memoryMegabytes": 4096,
          "processLimit": 512,
          "timeSeconds": 600
        }
      }
    }
  }
}
```

## Execution Design

Add a sandbox execution builder near `packages/opencode/src/tool/shell.ts` and keep `run(...)` mostly unchanged.

Behavior:

- Resolve `workdir` exactly as `ShellTool` does today through `ToolPath.primaryWithSession(...)`.
- Run existing permission scan and approval before sandbox setup.
- If sandbox disabled, use current `cmd(shell, command, cwd, env)` path.
- If sandbox enabled, replace shell command spawn with a Docker-backed sandbox command.
- Preserve merged shell env from `shellEnv(ctx, cwd)`, but pass env into the container explicitly.
- Mount workspace according to profile filesystem rules.
- Mount temporary directory when profile includes `temporaryDirectory`.
- Do not mount protected paths as writable.
- Return stdout/stderr, exit code, timeout text, and abort text through existing `run(...)` behavior.

Recommended first implementation seam:

- Keep `run(...)` and `ChildProcessSpawner` behavior intact.
- Change `cmd(...)` or introduce adjacent `sandboxCmd(...)` that returns `ChildProcess.Command`.
- Do not move sandboxing into `packages/core/src/cross-spawn-spawner.ts` in first pass.

## Network Behavior

Supported profile modes:

```json
{ "network": { "mode": "none" } }
```

- Must run container with no network access.

```json
{
  "network": {
    "mode": "allowlist",
    "hosts": ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]
  }
}
```

- Must allow outbound connections only to listed hostnames.
- Must reject empty `hosts`.
- Must resolve redirects through the same allowlist policy.
- Implementation may use a local egress proxy or Docker network policy, but tests must prove blocked non-allowlisted host access.

```json
{
  "network": {
    "mode": "full",
    "requiresApproval": true
  }
}
```

- Must ask for a sandbox network approval before execution.
- Approval should be separate from `bash` command approval.
- Default recommendation: add permission key `sandbox_network` in `packages/opencode/src/config/permission.ts`.
- Approval pattern should include profile and command summary, for example `sandbox_network:full:workspace`.

## Error Handling

- If Docker is not installed and sandbox is enabled, fail shell execution with: `Sandbox is enabled but Docker is unavailable`.
- If Docker exits before command execution, return Docker stderr in shell output.
- If profile references unsupported path tokens, fail config validation.
- If network `allowlist` cannot be enforced on the current platform, fail closed.
- If timeout fires, kill/remove the container and return existing timeout metadata.
- If user aborts, kill/remove the container and return existing abort metadata.

## Implementation Slices

### PR 1: Config Schema And Docs

- Add `sandbox` schema to `packages/opencode/src/config/config.ts`.
- Add focused validation for profile existence, network mode, allowlist hosts, and resource bounds.
- Add config docs in `packages/web/src/content/docs/config.mdx`.
- Add permission docs placeholder for future `sandbox_network` in `packages/web/src/content/docs/permissions.mdx` only if the permission key lands in this PR.
- Regenerate SDK because `Config.Info` changes.

Verification:

- `cd packages/opencode && bun typecheck`
- `./packages/sdk/js/script/build.ts`
- `cd packages/sdk/js && bun typecheck`

Review:

A fresh read-only reviewer must compare the diff against this spec and confirm the config shape, defaults, validation failures, docs, and SDK changes are limited to this slice.

### PR 2: Docker Sandbox For Shell With Network None

- Add sandbox command builder near `packages/opencode/src/tool/shell.ts`.
- Wire sandbox execution only for `ShellTool`.
- Support filesystem mounts for `workspace`, `systemRuntime`, and `temporaryDirectory`.
- Support `network.mode: "none"`.
- Preserve current permission prompts, output streaming, timeout, abort, and exit-code behavior.
- Add shell tests in `packages/opencode/test/tool/shell.test.ts`.
- Add external-directory regression tests in `packages/opencode/test/tool/external-directory.test.ts`.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/tool/shell.test.ts test/tool/external-directory.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only reviewer must verify no PTY, MCP, custom tool, or global process-spawner behavior changed in this slice.

### PR 3: Full Network With Approval

- Add `sandbox_network` permission key in `packages/opencode/src/config/permission.ts`.
- Ask `sandbox_network` before sandbox execution when profile network is `{ "mode": "full", "requiresApproval": true }`.
- Update TUI permission display in `packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx`.
- Update non-interactive behavior in `packages/opencode/src/cli/cmd/run.ts`; default must reject approval unless `--dangerously-skip-permissions` applies.
- Add permission tests in `packages/opencode/test/permission/next.test.ts`.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/permission/next.test.ts test/tool/shell.test.ts`
- `cd packages/opencode && bun typecheck`
- `./packages/sdk/js/script/build.ts`
- `cd packages/sdk/js && bun typecheck`

Review:

A fresh read-only reviewer must confirm network approval is separate from `bash` approval and that rejection prevents Docker execution.

### PR 4: Allowlist Network Enforcement

- Implement `network.mode: "allowlist"` with real egress enforcement.
- Add deterministic tests that allow `registry.npmjs.org` and block an unlisted host.
- Document allowlist limitations and failure-closed behavior in `packages/web/src/content/docs/config.mdx`.
- Do not ship DNS-only filtering if direct IP egress remains possible.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/tool/shell.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only reviewer must specifically challenge bypasses: direct IP access, redirects, DNS rebinding, and commands that start background processes.

### PR 5: Public Docs And Prompt Cleanup

- Update `packages/web/src/content/docs/tools.mdx` to explain that shell execution can be sandboxed.
- Update `packages/web/src/content/docs/plugins.mdx` to clarify `shell.env` env values are passed into sandboxed shell execution.
- Update stale non-sandboxed wording in `packages/opencode/src/session/prompt/kimi.txt` only if sandbox config is enabled in runtime prompt context.
- Update `packages/opencode/src/file/protected.ts` wording if protected-file behavior changes under sandboxing.
- Keep ecosystem/plugin references unchanged unless they become misleading.

Verification:

- `cd packages/web && bun run build`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only reviewer must verify docs do not imply sandboxing applies to PTY, MCP tools, custom tools, or plugins unless those surfaces are actually implemented.

## Future Work

- Per-agent sandbox profile overrides in `packages/opencode/src/config/agent.ts`.
- Sandbox support for PTY sessions in `packages/opencode/src/pty/index.ts`.
- Sandbox support for custom tools and MCP tools.
- A managed first-party sandbox image built from `packages/containers`.
- Persistent container reuse for faster repeated commands.
- UI indicators showing when a command ran in a sandbox.

## Open Questions

- Should the implementation invoke a literal `docker sandbox exec` command, or should opencode provide an internal `Sandbox.exec` abstraction backed by stable Docker CLI primitives? Default: use an internal `Sandbox.exec` abstraction so the implementation is not tied to a non-standard Docker subcommand.
- What base image should sandboxed shell commands use? Default: require an explicit configured image in the first implementation if no first-party image exists yet.
- Should `full` network without `requiresApproval` be allowed? Default: allow it only when config explicitly sets `{ "mode": "full", "requiresApproval": false }`; otherwise require approval.
