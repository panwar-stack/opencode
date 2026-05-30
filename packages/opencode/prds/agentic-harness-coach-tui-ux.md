# Agentic Harness Coach TUI UX

## Goal

Define how the Agentic Harness Coaching Layer should appear in the terminal TUI without becoming intrusive. The coach should reuse existing TUI surfaces, match the urgency of each coaching use case to the right interaction pattern, and keep users in control.

This document is a companion to `packages/opencode/prds/agentic-harness-coach.md`. It focuses on UI placement, event shape, and implementation slices for the terminal TUI and adjacent app surfaces.

## Current State

- The terminal TUI lives under `packages/opencode/src/cli/cmd/tui`, not `packages/tui`.
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` already supports prompt hints and right-side prompt content.
- `packages/opencode/src/cli/cmd/tui/routes/session/footer.tsx` and `packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx` provide compact persistent status surfaces.
- `packages/opencode/src/cli/cmd/tui/ui/toast.tsx` provides short-lived notifications and is exposed through the TUI plugin API.
- `packages/opencode/src/cli/cmd/tui/component/command-palette.tsx` already supports suggested commands.
- `packages/opencode/src/cli/cmd/tui/routes/session/question.tsx` provides a structured choice UI for questions that need a user answer.
- `packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx` provides a high-salience bottom panel pattern for risk or approval decisions.
- `packages/opencode/src/cli/cmd/tui/component/dialog-team.tsx` and `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/team.tsx` already expose team state, tasks, messages, questions, and pending permissions.
- `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/todo.tsx` and `packages/opencode/src/cli/cmd/tui/component/todo-item.tsx` provide a checklist pattern that maps well to coach checkpoints.
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` already renders inline tool and message rows that could host transcript-level coach annotations.
- `packages/opencode/src/cli/cmd/tui/event.ts` currently defines TUI events for prompt append, command execute, toast show, and session select.
- `packages/opencode/src/bus/index.ts` and `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts` provide the bus and SSE path for delivering shared events.
- `packages/opencode/src/session/prompt.ts` is the likely before-run hook for prompt, model, agent, shell, and command lifecycle events.
- `packages/opencode/src/session/processor.ts` is the likely during-run hook for tool calls, repeated tool use, step boundaries, failures, and runaway patterns.

## UX Principles

- Default to non-blocking guidance.
- Keep every coach surface dismissible.
- Match the UI surface to urgency instead of showing every tip as a modal or toast.
- Prefer contextual placement near the thing being coached.
- Use short, concrete language with a suggested change.
- Explain tradeoffs without false precision, especially for model cost or latency.
- Do not expose internal reasoning traces or implementation details.
- Do not make users feel judged. The tone should be advisory, not corrective.
- Avoid generic documentation panels. The coach should appear because of the user's current task.
- Escalate only when the issue is risky, repeated, or policy-backed.

## Intervention Ladder

The coach should use a tiered set of surfaces instead of one universal UI.

| Level | Surface | Use |
| --- | --- | --- |
| 1 | Prompt hint or prompt-right content | Low-priority pre-run advice while the user is composing |
| 2 | Footer or sidebar nudge | Persistent but compact session state |
| 3 | Suggested command | User-pulled action surfaced in the command palette |
| 4 | Toast | Short feedback or ephemeral reminder |
| 5 | Inline coach row or card | Important advice that should remain visible in context |
| 6 | Question-style bottom panel | A coaching moment that needs a user decision |
| 7 | Permission-style bottom panel | High-risk or policy-backed intervention |

## Existing TUI Surfaces To Reuse

| Existing surface | File | Coach fit |
| --- | --- | --- |
| Prompt hint and right slot | `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | Pre-run prompt quality, missing output format, acceptance criteria, missing context |
| TUI plugin slots | `packages/plugin/src/tui.ts` | Ambient extension points such as `home_prompt_right`, `session_prompt_right`, `home_bottom`, and `app_bottom` |
| Session footer | `packages/opencode/src/cli/cmd/tui/routes/session/footer.tsx` | Terse status like `coach: add verification` or `coach: team likely overkill` |
| Subagent footer | `packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx` | Lead/subagent-specific coaching, such as waiting for plan approval or missing handoff |
| Toast | `packages/opencode/src/cli/cmd/tui/ui/toast.tsx` | Confirmation, dismissal feedback, and low-stakes during-run reminders |
| Command palette suggested commands | `packages/opencode/src/cli/cmd/tui/component/command-palette.tsx` | Non-intrusive actions such as switch model, add acceptance criteria, open team panel, or run verification |
| Dialog select | `packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx` | Explicit coach menus and mode selection |
| Question prompt | `packages/opencode/src/cli/cmd/tui/routes/session/question.tsx` | Guided choices, such as choose verification, approve revision, or select a decomposition path |
| Permission prompt pattern | `packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx` | High-salience intervention for risky edits, runaway loops, or unverified final answers |
| Team dialog and sidebar | `packages/opencode/src/cli/cmd/tui/component/dialog-team.tsx`, `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/team.tsx` | Team complexity, duplicated roles, missing specialists, blocked teammates, lead approval, and handoff quality |
| Todo sidebar and items | `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/todo.tsx`, `packages/opencode/src/cli/cmd/tui/component/todo-item.tsx` | Coach-managed checkpoints such as define success criteria, gather context, decompose work, verify result |
| Inline session rows | `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | Transcript-level annotations and post-run summaries |
| Spinner | `packages/opencode/src/cli/cmd/tui/component/spinner.tsx` | Temporary `coach analyzing` or `checking plan` states |
| Status dialog | `packages/opencode/src/cli/cmd/tui/component/dialog-status.tsx` | Later inspection surface for coach mode, suppressed tips, and last recommendation |
| Which-key | `packages/opencode/src/cli/cmd/tui/feature-plugins/system/which-key.tsx` | Discoverability for coach commands with `Coach`, `Team`, and `Verification` categories |
| Home tips | `packages/opencode/src/cli/cmd/tui/feature-plugins/home/tips-view.tsx` | Onboarding-style guidance, not active session intervention |

## Use-Case UX Mapping

| Use case | Recommended UX | Rationale |
| --- | --- | --- |
| Better prompt suggestion | Prompt hint with an action to insert or replace text | The user is already composing, so coaching should stay near the input |
| Missing context detection | Prompt hint or suggested command to attach files/context | Context fixes are best handled before the run starts |
| Output format coaching | Prompt hint with one-click append | Low-risk improvement that should not block submission |
| Acceptance criteria coaching | Prompt hint plus optional todo checkpoint | Useful for both prompt quality and later verification |
| Broad task decomposition | Inline pre-run card or suggested command | Broader scope needs more explanation than a footer hint |
| Agent team overkill | Team sidebar or compact inline card with `Use single agent` action | Advice belongs near team state and should not shame the user |
| Team composition coaching | Team dialog/sidebar | Role duplication and missing specialists are team-level concerns |
| Cheaper model recommendation | Pre-run inline card with conservative copy | Cost advice needs enough context to explain the quality tradeoff |
| Premium model justification | Quiet footer or toast confirmation | Positive validation should not interrupt |
| Repeated tool or mistake detection | Footer/toast first, permission-style panel only for runaway behavior | During-run advice can be distracting, so escalation should be rare |
| Tool fit coaching | Suggested command or inline row near the relevant tool activity | Tool guidance is most useful close to the observed behavior |
| Post-run retrospective | Inline summary row after completion | Retrospectives should be visible but not block the next prompt |
| Save reusable template | Suggested command from the retrospective | Template saving is useful but optional |
| Learning mode | More visible inline cards and checklist items | New users benefit from stronger guidance |
| Quiet mode | Footer and command palette only, except high-risk cases | Expert users should not be interrupted by routine coaching |

## Data Model

Represent coach output as structured data instead of prose-only text.

```ts
type CoachTip = {
  id: string
  sessionID: string
  phase: "before" | "during" | "after"
  type:
    | "prompt_quality"
    | "missing_context"
    | "output_format"
    | "acceptance_criteria"
    | "task_decomposition"
    | "team_fit"
    | "model_fit"
    | "tool_fit"
    | "runaway_behavior"
    | "retrospective"
  severity: "hint" | "info" | "warning" | "risk"
  confidence: "low" | "medium" | "high"
  title: string
  message: string
  suggestedChange?: string
  actions?: CoachAction[]
  dedupeKey?: string
  dismissScopes?: Array<"run" | "task_type" | "global">
}

type CoachAction = {
  id: string
  label: string
  kind: "command" | "prompt_append" | "prompt_replace" | "model_switch" | "agent_switch" | "dismiss" | "feedback"
  commandID?: string
  value?: string
}
```

The first implementation does not need every field persisted. The event shape should still include enough structure to support actions, dedupe, dismissal, and later analytics.

## Event And Plumbing Design

Start with event-based delivery and add persistence only where the UX requires it.

Recommended event:

```ts
type CoachTipShowEvent = {
  type: "coach.tip.show"
  properties: CoachTip
}
```

Integration points:

- Publish through `packages/opencode/src/bus/index.ts` so both terminal TUI and app consumers can receive the same concept.
- Deliver through the existing SSE handler in `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`.
- Consume in terminal TUI near `packages/opencode/src/cli/cmd/tui/app.tsx`, where TUI events are already handled.
- If exposed through HTTP schemas or SDK types, regenerate the JavaScript SDK with `./packages/sdk/js/script/build.ts`.
- Keep high-frequency during-run tips deduped and throttled before publishing.

For a minimal terminal-only MVP, `tui.toast.show` can carry simple tips. This should not be the long-term shape because terminal toasts are too ephemeral and do not support the full action model.

## MVP Scope

The first pass should focus on pre-run coaching because it has the best value-to-interruption ratio.

Include:

- Prompt quality hints.
- Missing context hints.
- Output format hints.
- Acceptance criteria hints.
- Broad task decomposition hints.
- Agent team overkill detection.
- Conservative model fit recommendations.
- Basic dismissal and dedupe for repeated advice.

Exclude from first pass:

- Deep personalization.
- Organization policy enforcement.
- Historical user modeling.
- Precise cost or latency estimates.
- Blocking coach flows for ordinary prompt quality issues.
- Full persistent analytics dashboards.

## Implementation Slices

### PR 1: Structured Coach Tip Model And Event

- Add the shared `CoachTip` data shape and event definition.
- Add publishing support for `coach.tip.show` through the existing bus path.
- Add basic dedupe keys and dismissal scopes to the payload, even if persistence is deferred.
- Avoid message-part storage for first pass unless transcript persistence is explicitly required.

Verification:

- `bun typecheck` from `packages/opencode`
- If SDK-exposed schemas change, run `./packages/sdk/js/script/build.ts`

Review:

- Confirm the event shape supports prompt hints, team-fit tips, model-fit tips, and post-run summaries without adding new event types.
- Confirm high-frequency during-run events can be throttled before reaching SSE consumers.

### PR 2: Pre-Run Heuristic Analyzer

- Hook into the prompt submission path near `packages/opencode/src/session/prompt.ts`.
- Detect missing output format, missing acceptance criteria, broad scope, likely missing file/context references, simple-task team overkill, and low-risk model downsizing opportunities.
- Use conservative model recommendations. Do not recommend cheaper models unless task risk is low and confidence is high.
- Emit one or two highest-value tips, not a full checklist.

Verification:

- `bun typecheck` from `packages/opencode`
- Add focused tests from the relevant package directory if the analyzer is factored into a testable module.

Review:

- Check that common expert prompts are not flooded with obvious advice.
- Check that broad prompts receive useful advice before run start.

### PR 3: Terminal TUI Rendering

- Consume coach tip events in the terminal TUI.
- Render `hint` severity tips in the prompt area or footer.
- Render actionable pre-run tips as suggested command palette actions.
- Render short confirmations through existing toasts.
- Use question or permission-style panels only when `severity` is `risk` or an explicit user decision is required.

Verification:

- `bun typecheck` from `packages/opencode`
- Manually run the TUI from `packages/opencode` in tmux if visual inspection is needed: `tmux new-session -d -s opencode-dev 'bun dev'`
- Capture visual output with `tmux capture-pane -pt opencode-dev`
- Stop the session with `tmux kill-session -t opencode-dev`

Review:

- Confirm ordinary prompt coaching does not steal focus.
- Confirm dismissal removes the visible tip for the expected scope.
- Confirm command palette actions are discoverable and do not require users to learn new syntax.

### PR 4: Team And Checklist Coaching

- Add team-fit tips to the existing team sidebar/dialog surfaces.
- Add optional coach checkpoints to the todo sidebar for multi-step work.
- Show team overkill and missing-role suggestions near team state, not in unrelated global UI.

Verification:

- `bun typecheck` from `packages/opencode`
- Exercise a single-agent task and a multi-agent task in the TUI to confirm the surfaces differ appropriately.

Review:

- Confirm single-agent recommendations are advisory, not judgmental.
- Confirm checklist items do not duplicate existing todos in a confusing way.

### PR 5: Post-Run Retrospective

- Add an inline post-run coach summary after session completion.
- Include one or two concrete lessons, such as better prompt shape, model/team fit, or missing verification.
- Add a suggested command for saving a reusable template if the prompt improvement is meaningful.

Verification:

- `bun typecheck` from `packages/opencode`
- Run a short session and confirm the retrospective appears after completion, not during active generation.

Review:

- Confirm retrospective language is educational and concise.
- Confirm it does not pollute the assistant answer unless persistence is intentionally enabled.

## Risks

- Toast-only coaching would be too ephemeral for prompt rewrites, post-run learning, and feedback capture.
- Message-part encoding would require schema and sync changes, and may incorrectly imply coach tips are assistant output.
- During-run coaching can distract users if it appears too frequently.
- Model cost recommendations can damage trust if they are overconfident or imprecise.
- Terminal and app surfaces differ. Web toasts support richer actions than terminal toasts.
- Dismissal and feedback require storage if they must persist across sessions or task types.

## Future Work

- Learning, default, and quiet coach modes.
- Persistent feedback states: useful, not useful, wrong.
- Task-type and global suppression preferences.
- Organization-level policy warnings.
- Web/app timeline cards backed by `packages/app/src/pages/session/message-timeline.tsx` and `packages/app/src/pages/session/message-timeline.data.ts`.
- Status dialog section for coach mode, suppressed tips, and last recommendation.
- Template library for reusable improved prompts.

## Recommended First Decision

Use a shared `coach.tip.show` event and render it through a small terminal TUI coach store. Avoid storing coach tips as normal assistant messages in the first pass. This keeps the implementation flexible, avoids transcript pollution, and lets each use case choose the least intrusive existing TUI surface.
