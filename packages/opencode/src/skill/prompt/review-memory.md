<!--
  Built-in skill. Name and description are registered in code at
  packages/opencode/src/skill/index.ts (see REVIEW_MEMORY_SKILL_NAME
  and REVIEW_MEMORY_SKILL_DESCRIPTION). The body below becomes the
  skill's content.
-->

# Review Memory

Use historical review memory as advisory context when the user asks you to
write, change, debug, or review code in a repository that has memory indexed.

## When To Query

Query memory when past review feedback could affect the work:

- Before making non-trivial code changes in an existing repository.
- When touching files, directories, or patterns that may have project-specific review expectations.
- Before a final review response, PR summary, or recommendation that should account for historical feedback.
- When the user explicitly asks about prior review comments, project conventions, or repeated review issues.

Use the native CLI/service surface. Do not implement retrieval yourself.

```sh
opencode memory query "<task or concern>" --file <path>
opencode memory review --base dev
opencode memory review --pr <number>
```

Use `--json` only when structured output is useful for a script, test, or exact parsing.

## Authority And Conflicts

Historical memory is lower priority than current user instructions, repo
instructions, ADRs, current code, and explicit maintainer direction.

- Apply memory only when it still fits the current code and task.
- Treat citations and confidence as reasons to inspect, not as proof.
- If memory appears stale, explain why you did not apply it.
- If memory conflicts with current instructions or code, surface the conflict instead of silently choosing.
- Do not quote or inject raw review comments when a compact cited constraint is enough.

## What To Report

When memory affected the work, summarize it briefly in the final response:

- Mention the historical check or constraint that was applied.
- Include citations if the memory output provided them.
- Mention stale or conflicting guidance only when it changed your decision or is important for the user to know.

Keep this concise. Do not turn the final response into a memory dump.

## Boundaries

This skill is policy text only. Do not put crawling, indexing, ranking, auth,
caching, provider configuration, or database behavior here. Those belong to the
native `opencode memory` CLI and memory service.
