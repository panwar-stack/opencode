---
name: team-report
description: Generate a post-run agent-team effectiveness report and optional baseline comparisons.
---

Use this when you want a repeatable end-of-session analysis for team-orchestrated work.

- Run `team_report` as soon as the run reaches a meaningful end state. In the case of no active team, refer to last shutdown team in the current lead session.
- The tool reads team, teammate, task, and message telemetry and returns:
  - throughput and completion signals
  - task progression distribution
  - mailbox delivery and read timing
  - cost/token aggregates across lead + teammate sessions
- Optionally pass `compare_session_ids` to benchmark this run against direct/subagent-only baselines.

Use returned metadata to store session reports, or include the markdown output directly in handoff notes.
