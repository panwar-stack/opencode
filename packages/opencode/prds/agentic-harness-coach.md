# Product Requirements Document

# Agentic Harness Coaching Layer

## 1. Summary

The Agentic Harness Coaching Layer helps users become better operators of the harness while they work. It surfaces timely, contextual tips that improve task outcomes, reduce unnecessary cost, prevent overuse of complex agent teams, and teach users how to prompt, scope, and route work more effectively.

The product should feel like a helpful expert sitting beside the user, not a blocking reviewer. It should educate customers through practical guidance tied to their actual tasks, so they improve over time and build trust in the harness.

## 2. Problem

Users often under specify tasks, choose agent teams when a simpler workflow would work, select expensive models when cheaper models are sufficient, or provide prompts that make success harder than necessary.

Today, many users only learn this through failed runs, wasted tokens, longer wait times, or inconsistent outputs. The harness has an opportunity to convert those moments into coaching moments.

## 3. Goals

1. Help users create better prompts before a run starts.

2. Recommend the right level of harness complexity for the task.

3. Suggest cheaper or faster model options when quality is unlikely to suffer.

4. Help users understand when an agent team is useful and when it is unnecessary.

5. Teach users through small, contextual tips rather than long documentation.

6. Improve task success rate, user satisfaction, and trust.

7. Reduce waste caused by overscoped prompts, wrong model selection, and unnecessary agent orchestration.

8. Make users feel more skilled after each interaction with the harness.

## 4. Non goals

1. The coaching layer should not block expert users from proceeding.

2. It should not make users feel judged or corrected.

3. It should not optimize only for lower cost if quality, reliability, or safety would be harmed.

4. It should not become a generic documentation panel.

5. It should not expose internal system reasoning or implementation details.

## 5. Target users

### 5.1 New users

New users need help understanding how to write effective prompts, when to use agents, and how to select the right execution mode.

### 5.2 Power users

Power users want faster feedback, better defaults, and coaching that reduces repeated manual tuning.

### 5.3 Cost conscious teams

Teams with budgets need guidance that prevents unnecessary high cost model usage and oversized agent teams.

### 5.4 Enterprise administrators

Administrators want users to learn best practices without requiring training sessions or manual review.

## 6. Core concept

The harness should include an intelligent coaching system that watches the task lifecycle and offers tips at three points.

### 6.1 Before the run

The system reviews the user prompt, selected model, chosen agent team, tool usage, expected output, and task complexity. It surfaces actionable recommendations before execution.

Examples:

1. “This task looks like a simple rewrite. A single agent is likely enough.”

2. “You may get better results by adding the target audience and desired tone.”

3. “This looks suitable for a lower cost model because it is mostly formatting and grammar cleanup.”

4. “Consider adding acceptance criteria so the agent team can verify completion.”

### 6.2 During the run

The system detects signs of poor task setup, excessive exploration, repeated tool use, missing context, or runaway complexity. It provides light touch guidance without disrupting the run.

Examples:

1. “The team is spending most of its time clarifying requirements. Next time, include examples of the expected output.”

2. “This run appears broader than the original request. You may want to split it into research, implementation, and validation tasks.”

3. “The current agent setup may be too large for this task. A smaller team could complete similar work faster.”

### 6.3 After the run

The system summarizes what the user could improve next time. It compares the original prompt with a better version, explains model and team fit, and creates reusable prompt patterns.

Examples:

1. “A stronger version of your prompt would include success criteria, target files, and output format.”

2. “This run used a full agent team, but the final work was mostly single step editing. Next time, try single agent mode first.”

3. “You selected a premium model, but the task was mostly classification. A cheaper model would likely be sufficient.”

## 7. Key use cases

### 7.1 Better prompt suggestion

When a user enters a vague prompt, the harness suggests a stronger version.

User prompt:

“Fix this.”

Suggested improved prompt:

“Review the attached file for grammar, clarity, and tone. Preserve the original meaning. Return a clean edited version and a short list of important changes.”

Value:

Users learn what good prompts look like by seeing improvements applied to their own work.

### 7.2 Agent team overkill detection

When the user selects a multi agent workflow for a simple task, the harness recommends a simpler path.

Trigger examples:

1. Task is a rewrite, summary, extraction, classification, formatting, or simple code explanation.

2. Prompt has low ambiguity and does not require parallel research or implementation.

3. No external tools, repository edits, or multi step planning are needed.

Tip example:

“This may not need a full agent team. A single agent should be enough, and it will likely be faster and cheaper.”

### 7.3 Cheaper model recommendation

When the selected model is more powerful than needed, the harness recommends a lower cost option.

Trigger examples:

1. Task is low risk.

2. Task is mostly formatting, summarization, grammar correction, data extraction, or simple transformation.

3. Prompt does not require deep reasoning, large code changes, or complex planning.

Tip example:

“This task appears suitable for a lower cost model. You can likely save cost without a meaningful quality drop.”

### 7.4 Premium model justification

When the task is complex, the harness validates that a stronger model is appropriate.

Trigger examples:

1. Large codebase reasoning.

2. Ambiguous product strategy.

3. Multi file refactor.

4. Security sensitive review.

5. High value customer facing output.

Tip example:

“This task involves ambiguous requirements and multi step reasoning. A stronger model is a good fit.”

### 7.5 Missing context detection

When the prompt references files, requirements, code, customers, or decisions that were not provided, the harness asks the user to add context.

Tip example:

“You mentioned the existing spec, but no source document is attached. Add the spec or link the relevant files for a better result.”

### 7.6 Output format coaching

When the user does not specify the desired output format, the harness suggests one.

Tip example:

“Add the desired output format, such as checklist, diff, pull request description, table, or final document.”

### 7.7 Acceptance criteria coaching

When the task is likely to fail without a clear finish line, the harness recommends acceptance criteria.

Tip example:

“Define what done means. For example: all tests pass, no behavior changes, public interfaces remain unchanged, and a summary is included.”

### 7.8 Task decomposition coaching

When a task is too broad, the harness suggests splitting it.

Tip example:

“This task combines research, design, implementation, and validation. Consider running it as four smaller tasks for better control.”

### 7.9 Repeated mistake detection

When a user repeatedly submits prompts with similar gaps, the harness personalizes coaching.

Tip example:

“You often get better results when you include examples. Add one good example and one bad example before running.”

### 7.10 Tool fit coaching

When a user asks for work that would benefit from a tool or connector, the harness suggests the right capability.

Tip example:

“This task references repository behavior. Connect the repository so the harness can inspect the actual code.”

### 7.11 Team composition coaching

When the agent team has unnecessary roles, missing roles, or duplicated responsibilities, the harness suggests adjustments.

Tip example:

“You may not need separate research and planning agents for this task. A planner plus implementer should be enough.”

### 7.12 Run retrospective

After completion, the harness explains how the run could have been improved.

Example:

“Next time, include target files and success criteria. The agent team spent time discovering scope that could have been provided upfront.”

### 7.13 Learning mode for new users

New users can enable a more educational experience with more frequent explanations and examples.

### 7.14 Quiet mode for expert users

Expert users can reduce coaching frequency while preserving high confidence warnings.

### 7.15 Administrator policy guidance

Administrators can set organization preferences, such as encouraging lower cost models for simple tasks or warning before large agent team runs.

## 8. User experience requirements

### 8.1 Tips must be contextual

Each tip must be based on the actual task, selected model, chosen team, attached context, and recent run behavior.

### 8.2 Tips must be actionable

Every tip should explain what to change, why it matters, and provide a one click or copyable improvement when possible.

### 8.3 Tips must be concise

Tips should be short enough to read quickly inside the workflow.

### 8.4 Tips must not block by default

Users should be able to ignore tips unless the organization configures policy based warnings.

### 8.5 Tips must support one click actions

Examples:

1. Replace prompt with improved prompt.

2. Switch to recommended model.

3. Use single agent mode.

4. Add suggested acceptance criteria.

5. Split into subtasks.

6. Save as reusable template.

### 8.6 Tips must explain tradeoffs

When recommending a cheaper model or smaller team, the harness should explain the tradeoff.

Example:

“Lower cost model recommended. Best for formatting and extraction. Use the stronger model if accuracy on ambiguous requirements is critical.”

### 8.7 Tips must be dismissible

Users can dismiss a tip for the current run, for the task type, or globally.

### 8.8 Tips must learn from feedback

Users can mark tips as useful, not useful, or wrong. The system should use this feedback to improve future recommendations.

## 9. Feature requirements

### 9.1 Prompt quality analyzer

The harness analyzes prompts for:

1. Goal clarity.

2. Missing context.

3. Desired output format.

4. Constraints.

5. Examples.

6. Acceptance criteria.

7. Risk level.

8. Ambiguity.

9. Scope size.

10. Need for tools or files.

Output:

1. Prompt quality score.

2. Top improvement opportunities.

3. Suggested rewritten prompt.

4. Explanation of why the revision is better.

### 9.2 Agent team fit analyzer

The harness determines whether the selected agent setup matches the task.

Inputs:

1. Task type.

2. Scope.

3. Selected agents.

4. Number of agents.

5. Needed capabilities.

6. Historical run outcomes.

7. Expected complexity.

Outputs:

1. Team fit rating.

2. Simpler recommended setup.

3. Missing role warning.

4. Duplicate role warning.

5. Estimated speed and cost impact.

### 9.3 Model fit analyzer

The harness recommends the most appropriate model tier.

Inputs:

1. Task complexity.

2. Risk level.

3. Required reasoning depth.

4. Required accuracy.

5. Output type.

6. User selected model.

7. Organization budget preferences.

Outputs:

1. Recommended model.

2. Confidence level.

3. Cost impact.

4. Quality risk explanation.

5. Suggested fallback model if results are poor.

### 9.4 Cost and latency preview

Before execution, the harness estimates whether the chosen configuration is likely to be low, medium, or high cost and latency.

The preview should avoid false precision. It should use ranges and qualitative labels unless exact data is available.

### 9.5 Post run learning summary

After completion, the harness provides:

1. What worked well.

2. What made the run harder.

3. A better prompt for next time.

4. Whether the agent team was appropriate.

5. Whether the model choice was appropriate.

6. Suggested reusable template.

### 9.6 Prompt pattern library

The harness converts successful prompts into reusable templates.

Template examples:

1. Code refactor prompt.

2. Product requirements document prompt.

3. Bug investigation prompt.

4. Research synthesis prompt.

5. Customer email rewrite prompt.

6. Repository implementation prompt.

### 9.7 Coaching personalization

The harness adapts coaching based on:

1. User skill level.

2. Repeated behavior.

3. Accepted suggestions.

4. Dismissed suggestions.

5. Team or organization preferences.

6. Task history.

### 9.8 Admin controls

Administrators can configure:

1. Default coaching level.

2. Budget sensitivity.

3. Model recommendation policy.

4. Agent team warning thresholds.

5. Required warnings for high cost runs.

6. Whether users can override recommendations.

## 10. Tip types

### 10.1 Prompt improvement tip

Purpose:

Help the user write a clearer prompt.

Example:

“Add output format and acceptance criteria to improve reliability.”

### 10.2 Model selection tip

Purpose:

Guide users toward the right model.

Example:

“This task is mostly summarization. A lower cost model is likely enough.”

### 10.3 Agent team sizing tip

Purpose:

Prevent unnecessary orchestration.

Example:

“A full agent team may be more than this task needs.”

### 10.4 Scope control tip

Purpose:

Reduce task failure caused by oversized prompts.

Example:

“This task includes several goals. Split it into smaller runs for better results.”

### 10.5 Missing input tip

Purpose:

Detect absent context.

Example:

“Attach the source document so the harness can make accurate edits.”

### 10.6 Learning tip

Purpose:

Teach reusable best practices.

Example:

“Good harness prompts usually include goal, context, constraints, output format, and success criteria.”

### 10.7 Retrospective tip

Purpose:

Help the user improve after the run.

Example:

“The run succeeded, but the prompt required the agents to infer the target audience. Include that next time.”

## 11. Example user journeys

### 11.1 Simple rewrite task

User enters:

“Make this better.”

Harness response:

1. Suggests a stronger prompt.

2. Recommends single agent mode.

3. Recommends a lower cost model.

4. Offers one click prompt replacement.

Expected result:

User completes the task faster and learns to specify tone, audience, and output format.

### 11.2 Complex repository task

User enters:

“Implement the new billing flow.”

Harness response:

1. Detects missing requirements.

2. Asks for target files, expected behavior, tests, and rollout constraints.

3. Confirms that an agent team is appropriate.

4. Recommends a stronger model.

Expected result:

User adds detail before execution, increasing success probability.

### 11.3 Oversized agent team

User selects six agents for a grammar cleanup task.

Harness response:

1. Explains that the task is simple.

2. Recommends single agent mode.

3. Shows expected savings.

4. Lets the user continue anyway.

Expected result:

User learns when orchestration is unnecessary.

### 11.4 Post run education

A run completes with high cost and average output quality.

Harness response:

1. Explains that the prompt lacked acceptance criteria.

2. Shows a better prompt.

3. Notes that the selected team was larger than needed.

4. Suggests a cheaper configuration for similar tasks.

Expected result:

User feels coached rather than blamed.

## 12. Product principles

### 12.1 Helpful, not judgmental

The system should say “This may work better” rather than “You did this wrong.”

### 12.2 Teach through doing

The system should educate users inside their workflow, using their own examples.

### 12.3 Default to user control

The user remains in charge unless there is an organization policy.

### 12.4 Prefer specific advice

Generic tips should be avoided. The best tips reference the actual prompt and selected configuration.

### 12.5 Balance quality, cost, and speed

The harness should not always recommend cheaper options. It should recommend the best fit.

## 13. Measurement

### 13.1 Primary success metrics

1. Increase in successful runs.

2. Reduction in failed or abandoned runs.

3. Reduction in unnecessary agent team usage.

4. Reduction in avoidable high cost model usage.

5. Increase in user satisfaction after coached runs.

6. Increase in repeat usage.

### 13.2 Secondary metrics

1. Tip acceptance rate.

2. Prompt rewrite acceptance rate.

3. Model switch acceptance rate.

4. Agent team downsizing acceptance rate.

5. Tip dismissal rate.

6. Percentage of users who save reusable templates.

7. Reduction in average run cost for simple tasks.

8. Reduction in average time to successful output.

### 13.3 Quality guardrails

1. No increase in user reported poor quality.

2. No increase in reruns caused by underpowered model recommendations.

3. No meaningful slowdown in prompt submission flow.

4. Low rate of users disabling coaching entirely.

## 14. First release scope

### 14.1 Included

1. Prompt quality review before run.

2. Suggested improved prompt.

3. Agent team overkill detection.

4. Cheaper model recommendation for simple tasks.

5. Missing context warnings.

6. Output format suggestions.

7. Post run learning summary.

8. Tip feedback controls.

### 14.2 Not included

1. Full personalized learning curriculum.

2. Organization wide analytics dashboard.

3. Automatic agent team redesign for every task.

4. Deep historical user modeling.

5. Mandatory policy enforcement.

## 15. Future releases

### 15.1 Personalized coaching

The system learns each user’s patterns and provides targeted education.

### 15.2 Team level best practices

Teams can share prompt templates and recommended harness setups.

### 15.3 Cost governance

Administrators can create guidance rules for model usage and agent team size.

### 15.4 Benchmark based recommendations

The harness can compare similar historical tasks and suggest the setup that performed best.

### 15.5 Adaptive learning mode

The harness can teach users progressively, starting with basic prompt structure and advancing to task decomposition, evaluation design, and agent orchestration.

## 16. Open questions

1. How much cost information should be shown before the run?

2. Should users be able to auto apply all recommendations with one action?

3. How should the harness handle cases where cheaper models are likely sufficient but the task is business critical?

4. Should administrators be able to require warnings before high cost runs?

5. How should coaching frequency change as users become more experienced?

6. How should the system detect when a user prefers speed over cost savings?

7. Should the post run summary appear automatically or only when there is a meaningful lesson?

## 17. Risks

### 17.1 Users may feel interrupted

Mitigation:

Make tips concise, dismissible, and clearly useful.

### 17.2 Recommendations may be wrong

Mitigation:

Show confidence, explain tradeoffs, and allow feedback.

### 17.3 Cheaper model suggestions may harm output quality

Mitigation:

Only recommend cheaper models when confidence is high and risk is low.

### 17.4 Users may ignore coaching

Mitigation:

Use one click actions and show clear value, such as saved cost or improved prompt quality.

### 17.5 Expert users may find tips basic

Mitigation:

Offer quiet mode and advanced coaching settings.

## 18. Launch plan

### 18.1 Internal preview

Test tips on common workflows such as rewriting, summarization, coding tasks, repository edits, and product documentation.

### 18.2 Limited customer preview

Enable for a small group of customers with visible feedback controls.

### 18.3 General release

Launch with default coaching enabled at a moderate level.

### 18.4 Post launch improvements

Use feedback, run outcomes, and acceptance metrics to refine tip quality and reduce noise.

## 19. Example tip copy

### Better prompt

“Your prompt is understandable, but the harness may perform better with more structure. Add context, output format, and success criteria.”

### Agent team overkill

“This task looks simple enough for a single agent. A full team may add cost and time without improving quality.”

### Cheaper model

“This task is mostly formatting and cleanup. A lower cost model is likely a better fit.”

### Missing context

“The prompt references an existing implementation, but no files are attached. Add the relevant files or repository context before running.”

### Scope split

“This request combines several goals. Split it into smaller runs to improve control and review quality.”

### Post run learning

“Next time, include examples of the desired output. The agent team spent time inferring style and structure.”

## 20. Recommendation

Build the coaching layer as a core harness experience, not as a separate help feature. The product should teach users at the moment they are making decisions, then reinforce learning after the run. Done well, this creates better outcomes, lowers cost, and helps customers feel that the harness is making them more capable over time.
