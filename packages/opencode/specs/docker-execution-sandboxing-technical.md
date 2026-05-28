# Docker Execution Sandboxing Technical Spec

## Goal

Add Docker-backed runtime isolation for built-in shell execution while keeping permission prompts as a separate approval layer. The first implementation targets `ShellTool` only and leaves PTY, MCP tools, custom tools, plugin execution, and internal maintenance commands unchanged.

Success means an approved `bash` tool call can run inside a Docker sandbox with controlled filesystem mounts, network policy, process cleanup, and resource limits, while existing timeout, abort, output, and permission behavior remains intact.

## Current State

- `packages/opencode/src/tool/shell.ts` owns built-in shell execution through `ShellTool`.
- `ShellTool.execute()` resolves `workdir`, computes the command timeout, scans command permissions, asks `external_directory` and `bash` permissions, then calls `run(...)`.
- `packages/opencode/src/tool/shell.ts` `cmd(...)` currently returns the `ChildProcess.Command` used by `run(...)`; this is the narrowest integration point for sandboxed command construction.
- `packages/opencode/src/tool/shell.ts` `run(...)` already handles output streaming, exit code capture, abort, timeout, and process killing through `ChildProcessSpawner`.
- `packages/core/src/cross-spawn-spawner.ts` implements process spawning, detached process groups, env extension, and kill escalation.
- `packages/opencode/src/config/config.ts` defines `Config.Info`; adding `sandbox` changes the public config schema and SDK-generated types.
- `packages/opencode/src/config/permission.ts` defines permission action config. Sandbox runtime settings do not belong in permission config.
- `packages/opencode/src/permission/index.ts` provides runtime approval requests and replies.
- `packages/opencode/src/pty/index.ts` is a separate execution surface and must not be changed in the first implementation.
- Existing project/worktree sandbox terminology appears in `packages/opencode/src/project/project.ts`; docs must distinguish that from execution sandboxing.

## Non-Negotiables

- Missing `sandbox` config must keep current host execution behavior.
- `sandbox.enabled: false` must keep current host execution behavior.
- Existing `bash` and `external_directory` permission checks must happen before Docker execution is prepared.
- Docker setup must not bypass `ShellTool` timeout, abort, output truncation, or metadata behavior.
- Docker unavailability while sandboxing is enabled must fail closed with a clear tool error.
- Network allowlist mode must be enforced, not only documented.
- Full network mode with `requiresApproval: true` must request approval separately from the `bash` command approval.
- First implementation must not sandbox PTY sessions, MCP tools, custom tools, plugin hooks, or general process utilities.

## Config Model

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

Validation rules:

- `defaultProfile` defaults to `workspace` when omitted.
- `sandbox.enabled: true` requires `profiles[defaultProfile]` to exist.
- `network.mode: "allowlist"` requires at least one hostname.
- `resources.memoryMegabytes`, `resources.processLimit`, and `resources.timeSeconds` must be positive integers when provided.
- Unknown filesystem tokens must fail config validation.
- `protected` entries must be paths below `workspace` or `home`; absolute host paths are not accepted in the first implementation.

Initial supported config:

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

## Runtime Architecture

Introduce a small sandbox command builder near `packages/opencode/src/tool/shell.ts`.

```ts
type SandboxExecutionInput = {
  shell: string
  command: string
  cwd: string
  env: Record<string, string | undefined>
  profile: SandboxProfile
  workspace: string
  timeout: number
}
```

Execution flow:

- `ShellTool.execute()` resolves the primary session root and `workdir` as it does today.
- `ShellTool.execute()` runs the existing permission scan and `ask(...)` behavior.
- Sandbox profile resolution happens after permission approval.
- If sandboxing is disabled, existing `cmd(shell, command, cwd, env)` is used.
- If sandboxing is enabled, `sandboxCmd(input)` returns a Docker-backed `ChildProcess.Command`.
- `run(...)` continues to call `spawner.spawn(...)`, stream combined output, race exit against abort and timeout, and kill on abort or timeout.

The implementation may expose an internal `Sandbox.exec` abstraction that maps to stable Docker CLI primitives. The user-facing model can still be described as Docker sandbox execution; do not depend on a non-standard literal `docker sandbox exec` subcommand unless it is available and stable.

## Docker Command Construction

The sandbox command must be deterministic and explicit.

Required Docker behavior:

- Use `--rm` or equivalent cleanup.
- Use a generated container name that includes session or call identity when available.
- Set container working directory to the container path corresponding to resolved `cwd`.
- Pass shell env explicitly with `--env` entries.
- Mount workspace according to the active filesystem rules.
- Mount temporary directory when `temporaryDirectory` is writable.
- Apply `--network none` for `network.mode: "none"`.
- Apply memory limit when `resources.memoryMegabytes` is provided.
- Apply process limit when `resources.processLimit` is provided and supported by the Docker runtime.
- Use a command form that preserves current shell semantics for bash and PowerShell paths.

Failure behavior:

- Missing Docker binary returns `Sandbox is enabled but Docker is unavailable`.
- Docker daemon unavailable returns Docker's stderr with sandbox context.
- Unsupported resource option fails closed instead of silently ignoring the requested limit.
- Container cleanup must run on normal exit, timeout, and abort.

## Filesystem Policy

Path tokens resolve as follows:

- `workspace` resolves to the primary session root from `ToolPath.primaryWithSession(...)`.
- `workspace/<path>` resolves below the primary session root.
- `temporaryDirectory` resolves to the process temp directory used by opencode for temporary files.
- `systemRuntime` resolves to minimal runtime paths required for the configured sandbox image and shell to run.
- `home/<path>` resolves below the user's home directory, but first implementation should only support protected entries for these paths unless a read or write use case is explicitly added.

Rules:

- A path in `write` must be mounted writable unless it is also protected.
- A path in `read` must be mounted read-only unless also listed in `write`.
- A path in `protected` must not be writable.
- Protected files inside a writable mount need one of these approaches: mount the protected path back as read-only, mask it with an empty read-only mount, or split mounts so protected paths are excluded.
- If Docker cannot enforce the requested protected path behavior, fail closed.

## Network Policy

Supported modes:

```json
{ "network": { "mode": "none" } }
```

- Run with no network access.

```json
{
  "network": {
    "mode": "allowlist",
    "hosts": ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]
  }
}
```

- Allow outbound connections only to configured hostnames.
- Reject direct IP egress unless the IP is explicitly supported by the allowlist design.
- Apply the policy to redirects.
- Fail closed if the platform cannot enforce this mode.

```json
{
  "network": {
    "mode": "full",
    "requiresApproval": true
  }
}
```

- Request `sandbox_network` approval before execution.
- Use approval pattern `sandbox_network:full:<profile>`.
- Reject execution if approval is denied.

## Permission Integration

Sandboxing is not a replacement for permissions.

Existing permission behavior remains:

- `packages/opencode/src/tool/shell.ts` scans shell command patterns.
- `external_directory` prompts still guard host paths outside session roots.
- `bash` prompts still guard command execution.

New permission behavior:

- Add `sandbox_network` to `packages/opencode/src/config/permission.ts` only when full-network approval is implemented.
- Add TUI copy in `packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx` for `sandbox_network`.
- Non-interactive `packages/opencode/src/cli/cmd/run.ts` must reject `sandbox_network` by default unless existing skip-permissions behavior applies.

## Implementation Slices

### Slice 1: Config Schema

- Add `sandbox` schema to `packages/opencode/src/config/config.ts`.
- Validate profile existence, network modes, allowlist hosts, resource values, and path tokens.
- Add config documentation to `packages/web/src/content/docs/config.mdx`.
- Regenerate generated SDK types.

Verification:

- `cd packages/opencode && bun typecheck`
- `./packages/sdk/js/script/build.ts`
- `cd packages/sdk/js && bun typecheck`

Adversarial check:

- A fresh read-only reviewer verifies defaults, invalid config failures, schema exposure, and docs match this spec.

### Slice 2: Shell Sandbox With No Network

- Add `sandboxCmd(...)` near `packages/opencode/src/tool/shell.ts`.
- Use sandbox execution only for `ShellTool`.
- Implement workspace and temporary directory mounts.
- Implement `network.mode: "none"`.
- Preserve existing output, timeout, abort, and exit-code behavior through `run(...)`.
- Add shell tests in `packages/opencode/test/tool/shell.test.ts`.
- Add external-directory regression tests in `packages/opencode/test/tool/external-directory.test.ts`.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/tool/shell.test.ts test/tool/external-directory.test.ts`
- `cd packages/opencode && bun typecheck`

Adversarial check:

- A fresh read-only reviewer verifies no PTY, MCP, custom tool, plugin, or global process-spawner behavior changed.

### Slice 3: Protected Paths And Resources

- Enforce `filesystem.protected` paths inside otherwise writable mounts.
- Apply memory, process, and time resource settings when Docker supports them.
- Fail closed when requested protections or limits cannot be enforced.
- Add tests for blocked writes to `workspace/.opencode`, `workspace/AGENTS.md`, and `home/.ssh` when configured.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/tool/shell.test.ts`
- `cd packages/opencode && bun typecheck`

Adversarial check:

- A fresh read-only reviewer attempts to identify writable protected-path bypasses through symlinks, nested paths, and shell redirection.

### Slice 4: Full Network Approval

- Add `sandbox_network` permission schema support in `packages/opencode/src/config/permission.ts`.
- Ask `sandbox_network` when profile network is full and `requiresApproval` is true.
- Add TUI permission display for `sandbox_network`.
- Ensure non-interactive runs reject the request unless skip-permissions mode applies.
- Add permission tests in `packages/opencode/test/permission/next.test.ts`.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/permission/next.test.ts test/tool/shell.test.ts`
- `cd packages/opencode && bun typecheck`
- `./packages/sdk/js/script/build.ts`
- `cd packages/sdk/js && bun typecheck`

Adversarial check:

- A fresh read-only reviewer verifies `sandbox_network` approval is separate from `bash` approval and that denial prevents Docker execution.

### Slice 5: Allowlist Network

- Implement `network.mode: "allowlist"` with enforceable egress controls.
- Add tests that allow a configured host and block an unlisted host.
- Cover direct IP access and redirect behavior in tests or documented manual verification.
- Document fail-closed behavior in `packages/web/src/content/docs/config.mdx`.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/tool/shell.test.ts`
- `cd packages/opencode && bun typecheck`

Adversarial check:

- A fresh read-only reviewer challenges direct IP egress, DNS rebinding, redirects, and background child process escape paths.

### Slice 6: Public Documentation

- Update `packages/web/src/content/docs/tools.mdx` to describe sandboxed shell execution.
- Update `packages/web/src/content/docs/permissions.mdx` if `sandbox_network` is shipped.
- Update `packages/web/src/content/docs/plugins.mdx` to describe how `shell.env` values enter sandboxed execution.
- Update `packages/opencode/src/session/prompt/kimi.txt` only if runtime prompt context can accurately state sandbox status.
- Update `packages/opencode/src/file/protected.ts` only if protected file messaging changes.

Verification:

- `cd packages/web && bun run build`
- `cd packages/opencode && bun typecheck`

Adversarial check:

- A fresh read-only reviewer verifies docs do not imply sandboxing applies outside `ShellTool`.

## Deterministic Checks

- With no sandbox config, `ShellTool` command behavior and tests remain unchanged.
- With `network.mode: "none"`, a command that needs network access fails inside the sandbox.
- With `network.mode: "full"` and approval rejected, no Docker command is spawned.
- With protected `workspace/AGENTS.md`, a shell command cannot overwrite that file from inside the sandbox.
- With timeout shorter than command duration, the container is removed and the result uses existing timeout metadata.
- With abort triggered during command execution, the container is killed and removed.

## Future Work

- Per-agent sandbox profile overrides in `packages/opencode/src/config/agent.ts`.
- PTY sandboxing in `packages/opencode/src/pty/index.ts`.
- Custom tool and MCP sandboxing.
- First-party sandbox image built from `packages/containers`.
- Persistent sandbox containers for faster repeated commands.
- TUI indicators for sandboxed command execution.

## Open Questions

- What container image should be the default? Default recommendation: require explicit config until a first-party image is shipped.
- Should full network without `requiresApproval` be allowed? Default recommendation: allow only when explicitly configured as `{ "mode": "full", "requiresApproval": false }`.
- Should `home/<path>` ever be readable or writable in the first implementation? Default recommendation: no, only support it for protected-path declarations.
