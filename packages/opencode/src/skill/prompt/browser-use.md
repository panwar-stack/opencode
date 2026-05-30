<!--
  Built-in skill. Name and description are registered in code at
  packages/opencode/src/skill/index.ts (see BROWSER_USE_SKILL_NAME
  and BROWSER_USE_SKILL_DESCRIPTION). The body below becomes the
  skill's content.
-->

# Browser Use

Use browser-use for browser tasks that need visual navigation, clicking, typing, page-state inspection, content extraction, authenticated browsing, uploads, downloads, or interactive web workflows.

## Tool Choice

- Prefer deterministic MCP browser tools before autonomous control: navigate, get state, click, type, screenshot, extract content, tab controls, and session controls.
- Use autonomous browser-use agent fallback only when deterministic browser controls are insufficient for the task.
- Inspect the current page state before acting.
- Verify page state after acting, especially after navigation, form entry, file operations, or actions that change remote data.
- Keep browser actions local unless the user explicitly opts into a cloud Browser Use MCP server.

## Sensitive Actions

Ask the user before using browser-use to:

- Enter credentials, API keys, TOTP codes, or other secrets.
- Log into an account or use an existing authenticated browser profile/session.
- Submit forms with personal, financial, medical, legal, or private data.
- Send messages, emails, comments, posts, reviews, or other user-authored content.
- Make purchases, payments, trades, bookings, subscriptions, or other commitments.
- Delete, overwrite, publish, share, export, import, clear, or sync data.
- Upload local files or download files.
- Run JavaScript evaluation in a page.
- Open local tunnels, expose local services, or use cloud Browser Use MCP.

## Permission Model

opencode MCP permissions are tool-level permissions. They do not understand the semantic intent of a browser action. If a generic browser tool could perform a sensitive action, ask the user before invoking it for that purpose unless the user has already explicitly allowed that exact action.

Cloud Browser Use MCP can send browser session contents, prompts, screenshots, or recordings to a third party and may incur cost. Ask before using cloud mode, and do not sync local profiles to cloud unless the user explicitly requests it.
