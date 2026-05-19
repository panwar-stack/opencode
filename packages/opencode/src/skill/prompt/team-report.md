<!--
  Built-in skill. Name and description are registered in code at
  packages/opencode/src/skill/index.ts (see TEAM_REPORT_SKILL_NAME
  and TEAM_REPORT_SKILL_DESCRIPTION). The body below becomes the
  skill's content.
-->

# Team Report

Use this when you want a repeatable end-of-session analysis for team-orchestrated work.

- Run `team_report` as soon as the run reaches a meaningful end state. In the case of no active team, refer to last shutdown team in the current lead session.
- The tool reads team, teammate, task, and message telemetry and returns throughput, task progression, mailbox delivery, cost, token, and evaluation summaries.
- Optionally pass `compare_session_ids` to benchmark this run against direct/subagent-only baselines.

Use returned metadata to store session reports, or include the markdown output directly in handoff notes.
