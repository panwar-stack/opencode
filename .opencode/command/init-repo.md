---
name: init-repo
description: Run the init command and extend the generated skill or instruction output with core engineering principles. Use when setting up or refreshing project guidance and the user wants the normal init output plus explicit coding principles.
---

# Init With Principles

## Overview

Run `/init` for the current project, then preserve its generated output while adding a concise principles section to the relevant skill, agent, or instruction file.

## Workflow

1. Run `/init` in the current project.
2. Inspect the files created or updated by init before making any edits.
3. Preserve the init-generated structure and content unless it directly conflicts with the requested additions.
4. Add the principles below to the relevant skills, agent guidance, or project instruction section created by init.
5. Verify that the updated file still follows the expected skill or instruction format.

## Required Principles

Add these principles exactly in spirit, adjusting only formatting to match the target file:

1. Think before coding - Don't assume. Don't hide confusion. Surface tradeoffs.
2. Simplicity first - Minimum code that solves the problem. Nothing speculative.
3. Surgical changes - Touch only what you must. Clean up only your own mess.
4. Goal-driven execution - Define success criteria. Loop until verified.

## Writing Rules

- Keep the init output intact; append or merge the principles instead of replacing existing guidance.
- Make the smallest edit that adds the principles clearly.
- Do not add unrelated rules, templates, or speculative workflow changes.
- If `/init` is unavailable or fails, report the exact blocker and do not invent generated content.
