# GitHub PR Review Memory

## Problem

Engineering teams working on large projects accumulate important context in GitHub PR review comments. These comments often capture architectural boundaries, testing expectations, style preferences, previous failure modes, and reviewer decisions that are not written down elsewhere.

Today that knowledge is hard to reuse. Engineers and agents must rediscover it by searching old PRs manually, and reviewers repeatedly leave the same comments across similar changes.

## Goal

Make historical PR review comments available as proactive, task-specific context during coding work.

opencode should use past review feedback to help with:

- adding new features
- fixing bugs
- updating existing files
- reviewing diffs before final response or PR creation
- explaining project-specific conventions to new contributors

The system should turn review history into actionable constraints, not raw comment dumps.

## Non-Goals

- Do not blindly enforce every historical comment.
- Do not treat old review feedback as more authoritative than current code, ADRs, or explicit user instructions.
- Do not inject large volumes of raw PR text into the model context.
- Do not make GitHub PR comments the only supported source of external memory.

## Proposed Shape

This should be a harness-level capability, with a built-in GitHub provider and optional skill/policy layers.

```text
Coding Task
  -> Detect affected files, symbols, modules, and intent
  -> Query review-memory provider
  -> Inject compact historical constraints
  -> Implement the change
  -> Run a diff-aware historical review pass
  -> Report applied checks and unresolved conflicts
```

## Core Harness Capability

Add a generic context or memory provider primitive to the coding harness. The primitive should support task-aware retrieval from external knowledge sources.

The harness should not hardcode GitHub PR comments as the only source. The same mechanism should eventually support ADRs, incident reports, design docs, issue trackers, Slack exports, or internal policy systems.

Useful hooks include:

- pre-task context retrieval
- pre-edit context retrieval for affected files
- pre-final diff review
- citation support for surfaced guidance
- compact context injection into agent prompts

## Built-In GitHub Review Memory Provider

Ship a first-party provider that can index and retrieve GitHub PR review comments.

The provider should handle:

- GitHub authentication through existing GitHub or `gh` credentials
- incremental fetching of PR review comments and threads
- local caching and re-indexing
- relevance ranking by file path, directory, symbol, task intent, diff shape, labels, PR title, and reviewer
- deduplication of repeated feedback
- citation links back to original PRs and comments
- summarization into short constraints

Example retrieved context:

```text
Historical review constraints for src/config/*:
- Follow the self-reexport pattern.
- Avoid adding barrel index.ts files in multi-sibling directories.
- Prefer schema helpers over manual JSON.parse for untrusted strings.
Relevant PRs: #1234, #1398, #1412.
```

## Built-In Skill

A built-in skill should teach the agent how to use review memory correctly.

The skill should cover:

- when to query historical review memory
- how to distinguish applicable guidance from stale comments
- how to handle conflicting comments
- how to cite prior reviews without overloading the user
- how to include a concise final summary of historical checks

The skill should not own crawling, indexing, ranking, authentication, or caching. Those belong in the harness/provider layer.

## User And Project Policy

Teams should be able to customize how historical review memory is interpreted.

Examples:

- Treat comments from CODEOWNERS as high confidence.
- Prefer recent comments unless an older comment links to an ADR.
- Ignore one-off `nit` comments unless the same pattern appears repeatedly.
- Treat security review comments as high priority for auth, crypto, and permission changes.
- Surface conflicts between historical comments and current code instead of deciding silently.

This customization can live in project config, user config, or user-defined skills.

## Task Lifecycle Integration

### Before Changing Code

When a user asks opencode to add a feature, update a file, or fix a bug, opencode should identify the likely affected area and retrieve relevant review memory.

Example:

```text
Task: Add a new config module.

Historical review checks:
- Past reviews require the self-reexport pattern in src/config.
- Tests should avoid mocks when the real implementation is practical.
- Do not add barrel index.ts files in multi-sibling directories.
```

### During Implementation

As files become part of the working set, opencode can retrieve additional comments tied to those files or directories.

Example:

```text
You are adding src/session/cache.ts.

Relevant past review:
PR #1432: Avoid shared singleton state for per-project data. Use InstanceState.

Action:
Use InstanceState because this state is scoped by project directory.
```

### Before Final Response Or PR Creation

After implementation, opencode should run a historical review pass over the diff.

Example:

```text
Historical review check:
- Follows the existing Effect service pattern.
- Uses FileSystem service instead of fs/promises.
- Preserves module self-reexport convention.

Potential issue:
- New test uses a mock, but repeated past reviews in this package preferred real implementations.
```

## Bug Fix Behavior

For bug fixes, the provider should search for prior mentions of:

- the same error message
- the same stack trace
- the same module or function
- previous regressions
- reverted or follow-up PRs
- comments describing known edge cases

Example:

```text
Past review insight:
A previous fix in PR #982 warned that this path also runs in headless mode.
The current fix only handles TUI mode.

Suggested action:
Check both TUI and headless call sites before finalizing.
```

## Feature Work Behavior

For new features, review memory should help infer hidden expectations.

Example:

```text
Feature: Add provider setting.

Historical expectations:
- Config schema should live in src/config.
- CLI flag and config file behavior should match.
- SDK regeneration may be needed.
- Tests should cover config parsing and defaults.
```

## Existing File Updates

For edits to existing files, review memory should prioritize comments on the same file and nearby code.

Example:

```text
You are editing src/project/bootstrap.ts.

Past review context:
This file intentionally forks service init() with Effect.forkDetach.
Do not move concurrency inside individual init methods.
```

## User Experience

The feature should feel automatic and quiet by default.

Example interaction:

```text
User: Fix the session retry bug.

opencode:
I found past review comments around session retry and Effect scoping.
The key constraint is that retry loops must be scoped and interrupted with the project instance.
I will use that while making the fix.
```

Example final response:

```text
Fixed the retry bug in src/session/retry.ts.

Historical review memory applied:
- Preserved InstanceState scoping based on prior review guidance.
- Avoided adding shared singleton state.
- Checked previous retry-loop comments for similar edge cases.

Verification:
- bun typecheck passed.
- session retry tests passed.
```

## Confidence And Conflict Handling

Historical comments should be ranked by confidence.

Signals that increase confidence:

- repeated comments across multiple PRs
- comments from CODEOWNERS or maintainers
- comments linked to ADRs or docs
- recent comments
- comments on the same file or symbol
- comments that match the current diff pattern

Signals that decrease confidence:

- old comments that conflict with current code
- comments marked as `nit` or optional
- comments from abandoned approaches
- one-off subjective preferences
- comments contradicted by newer PRs

When guidance conflicts, opencode should surface the conflict and avoid silently choosing unless the current task gives enough context.

## Open Questions

- Where should the local index live, and how should it be scoped per repository?
- What is the right retention strategy for old PR comments?
- Should indexing happen eagerly, lazily, or only when enabled per project?
- How should private repository data be protected in cache files?
- What UI should expose citations without distracting from the coding task?
- How should the system distinguish resolved review comments from still-relevant guidance?
