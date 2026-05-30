# Built-In Browser-Use Skill

## Goal

Add `browser-use` as a built-in opencode capability through a built-in skill plus a default local MCP integration.

The model should learn when and how to invoke browser automation from the built-in `browser-use` skill. The executable surface should come from the existing Python `browser-use` package through its MCP server, not from a new native browser automation implementation in opencode.

## Current State

- Built-in skills are registered in `packages/opencode/src/skill/index.ts`.
- Built-in skill prompt bodies live under `packages/opencode/src/skill/prompt/*.md`.
- The native `skill` tool lives in `packages/opencode/src/tool/skill.ts` and already gates skill loading through `permission.skill`.
- MCP config is defined in `packages/opencode/src/config/mcp.ts`.
- Top-level config is defined in `packages/opencode/src/config/config.ts`.
- MCP runtime connection logic lives in `packages/opencode/src/mcp/index.ts`.
- MCP tools are added to session tools in `packages/opencode/src/session/tools.ts`.
- MCP tool permission keys use sanitized names like `<server>_<tool>`, for example `browser_use_browser_navigate`.
- Permission config is defined in `packages/opencode/src/config/permission.ts`.
- Existing permissions can already target custom/MCP tool names through rest keys.
- Existing specs live under `packages/opencode/specs/`.

## Non-Negotiables

- Do not reimplement browser automation in TypeScript for the first version.
- Use the existing `browser-use` Python package and its MCP support.
- Enable the capability by default, but make it disableable through config.
- Make browser actions permissionable through opencode permissions.
- Default to visible browser control.
- Support reuse of an existing visible browser when configured.
- Ask before sensitive browser actions.
- Allow downloads, uploads, and authenticated sessions, but keep them permission-gated.
- Do not pipe remote shell install scripts into a shell.
- Cloud Browser Use MCP must be opt-in because it can send browsing data to a third party and may incur cost.

## Design

### Built-In Skill

Add a built-in skill named `browser-use`.

Files:

- `packages/opencode/src/skill/index.ts`
- `packages/opencode/src/skill/prompt/browser-use.md`
- `packages/opencode/test/skill/skill.test.ts`
- `packages/opencode/test/tool/skill.test.ts`

Skill behavior:

- Explain that the model should use browser-use for browser tasks requiring visual navigation, clicking, typing, extraction, authenticated browsing, uploads, downloads, and interactive web workflows.
- Prefer deterministic MCP browser tools first, such as navigate, get state, click, type, screenshot, extract content, and tab/session controls.
- Use autonomous browser-use agent fallback only when deterministic browser controls are insufficient.
- Instruct the model to inspect page state before acting and verify state after acting.
- Instruct the model to ask before sensitive actions.
- Instruct the model not to enter credentials, submit purchases, upload files, download files, send messages, delete data, or perform irreversible actions without permission.

### Default MCP Integration

Add a default MCP server entry named `browser_use`.

Default local MCP command:

```json
{
  "type": "local",
  "command": ["uvx", "browser-use[cli]", "--mcp", "--headed"],
  "enabled": true,
  "timeout": 120000
}
```

Implementation note:

- Verify the exact current `browser-use` CLI MCP flags before implementation.
- If `uvx browser-use[cli] --mcp --headed` is not valid, use the closest supported stdio MCP command from the current browser-use CLI.
- Do not silently fall back to arbitrary shell installation.
- If `uvx` is missing or browser-use cannot start, expose a clear MCP connection error with install instructions.

Disable through config:

```json
{
  "mcp": {
    "browser_use": {
      "enabled": false
    }
  }
}
```

Override command through config:

```json
{
  "mcp": {
    "browser_use": {
      "type": "local",
      "command": ["browser-use", "--mcp", "--headed"],
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

Existing browser reuse through CDP:

```json
{
  "mcp": {
    "browser_use": {
      "type": "local",
      "command": [
        "uvx",
        "browser-use[cli]",
        "--mcp",
        "--headed",
        "--cdp-url",
        "http://localhost:9222"
      ],
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

Chrome example for users:

```bash
open -a "Google Chrome" --args --remote-debugging-port=9222
```

### Config Merge Behavior

- Inject the default `browser_use` MCP entry only when `cfg.mcp.browser_use` is missing.
- If user config defines `mcp.browser_use`, do not merge defaults into it except through existing config merge behavior.
- If user config defines `mcp.browser_use.enabled: false`, do not start browser-use.
- Preserve existing MCP behavior for all other servers.
- Do not add a new MCP transport type in the first version.

### Permissions

Default permission posture:

```json
{
  "permission": {
    "browser_use_*": "ask"
  }
}
```

Recommended user opt-out:

```json
{
  "permission": {
    "browser_use_*": "deny"
  }
}
```

Recommended trusted-project opt-in:

```json
{
  "permission": {
    "browser_use_*": "allow"
  }
}
```

Sensitive actions that must ask unless explicitly allowed:

- Entering credentials, API keys, TOTP codes, or other secrets.
- Logging into an account.
- Submitting forms with personal, financial, medical, legal, or private data.
- Sending messages, emails, comments, posts, or reviews.
- Making purchases, payments, trades, bookings, or subscriptions.
- Deleting, overwriting, publishing, or sharing data.
- Uploading local files.
- Downloading files.
- Exporting, importing, clearing, or syncing cookies/profiles.
- Using an existing browser profile or authenticated session.
- Running JavaScript evaluation in a page.
- Opening local tunnels or exposing local services.
- Using cloud Browser Use MCP.

Implementation constraint:

- Existing MCP permissions are tool-level, not semantic-action-level.
- If browser-use MCP exposes separate tools for uploads, downloads, cookies, JavaScript eval, or autonomous agent fallback, configure those tools to ask by default.
- If browser-use MCP exposes sensitive actions through generic tools like `browser_type` or `retry_with_browser_use_agent`, the skill instructions must require the model to ask before using them for sensitive purposes.

### Cloud MCP

Cloud MCP should not be enabled by default.

Opt-in config:

```json
{
  "mcp": {
    "browser_use_cloud": {
      "type": "remote",
      "url": "https://api.browser-use.com/v3/mcp",
      "headers": {
        "X-Browser-Use-API-Key": "${BROWSER_USE_API_KEY}"
      },
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

Cloud MCP skill guidance:

- Ask before using cloud mode.
- Treat cloud mode as data egress.
- Warn that browser session contents, prompts, screenshots, and recordings may leave the local machine depending on Browser Use behavior.
- Do not sync local profiles to cloud unless explicitly requested.

## Error Handling

- If `uvx` is unavailable, show a clear error that Python `uv` is required for the default browser-use MCP command.
- If Python is too old, show that browser-use requires Python `>=3.11`.
- If browser-use browser dependencies are missing, recommend running the official browser-use install command, not a shell pipe.
- If CDP connection fails, tell the user how to start Chrome with `--remote-debugging-port=9222`.
- If the MCP server starts but exposes no tools, show the MCP server status and command used.
- If `mcp.browser_use.enabled` is false, omit browser-use tools and keep the built-in skill available unless `permission.skill` disables it.

## Implementation Slices

### PR 1: Built-In Skill

- Add `browser-use` constants and registration in `packages/opencode/src/skill/index.ts`.
- Add `packages/opencode/src/skill/prompt/browser-use.md`.
- Document safe browser-use workflow in the skill body.
- Update skill tests to include `browser-use`.
- Update tool skill tests to verify built-in skill output uses `<built-in>` behavior.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/skill/skill.test.ts test/tool/skill.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

- A read-only reviewer checks that the skill is instructional only and does not add runtime behavior.
- A read-only reviewer checks that permission wording does not imply unavailable semantic permission enforcement.

### PR 2: Default Browser-Use MCP Injection

- Add a default MCP entry for `browser_use` before MCP state loads config.
- Use local stdio MCP through the browser-use CLI.
- Preserve user override behavior for `mcp.browser_use`.
- Support disabling with `mcp.browser_use.enabled: false`.
- Add tests for default injection, user override, and user disable.
- Add clear startup diagnostics when the default command cannot run.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/server/httpapi-mcp.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

- A read-only reviewer checks config merge precedence.
- A read-only reviewer checks that no unrelated MCP behavior changed.

### PR 3: Permission Defaults And Docs

- Add explicit default permission behavior for `browser_use_*`.
- Ensure browser-use MCP tools are filtered when denied.
- Document disablement through `mcp.browser_use.enabled: false`.
- Document deny through `permission.browser_use_*: "deny"` if the current config schema supports wildcard rest keys as expected.
- Add examples for ask, allow, and deny.
- Update public MCP and skill docs where appropriate.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/permission/*.test.ts test/tool/skill.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

- A read-only reviewer checks that sensitive actions default to ask.
- A read-only reviewer checks docs match actual config schema names.

### PR 4: Browser Profile And Existing Browser Guidance

- Add documented examples for visible headed browser mode.
- Add documented examples for CDP reuse through `--cdp-url`.
- Add documented examples for using an installed `browser-use` command instead of `uvx`.
- Keep real browser profile reuse opt-in through explicit config.
- Do not add automatic Chrome launching beyond the browser-use MCP command.

Verification:

- `cd packages/opencode && bun typecheck`
- Manually start Chrome with `--remote-debugging-port=9222` and verify the configured MCP command connects.

Review:

- A read-only reviewer checks that existing browser/profile reuse is opt-in and clearly documented.
- A read-only reviewer checks no credentials or local profile paths are logged.

## Future Work

- Add a first-class `browser_use` config block if MCP config becomes too verbose.
- Add semantic permission prompts for browser actions beyond tool-level MCP permissions.
- Add domain allowlists for browser navigation.
- Add UI affordances in TUI/desktop for visible browser session state.
- Add cloud Browser Use as a guided opt-in setup flow.
- Add install health checks such as `browser-use doctor`.

## Open Questions

- Exact browser-use CLI MCP command must be verified against the current package before implementation.
- Exact MCP tool names must be captured from the current browser-use MCP server before writing permission examples in docs.
- Whether opencode should inject `browser_use_*: ask` into default agent permissions or only document the recommended permission config.
