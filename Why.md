# Why This Version

This version is for people who want opencode to handle larger, more review-heavy work with more structure.

It is not trying to claim the forked version is wrong or obsolete. The difference is focus. These changes move opencode from a mostly single-assistant workflow toward coordinated, inspectable AI-assisted development.

The biggest addition is experimental agent teams. A lead session can split work across named teammates, coordinate through messages and shared tasks, wait on dependencies, request plan approval, and produce a report afterward. That matters when a task is too broad for one linear chat loop.

There are also smaller but useful improvements around visibility. Session exports include child session work, AI processing time is tracked more clearly, and team reports help explain what happened during a coordinated run. Built-in workflows like spec planning, initialization guidance, and team reporting make repeated engineering tasks easier to standardize.

Some of this is still early. Agent teams are experimental. Team reports are operational signals, not proof of correctness. Multi-root session work is foundational rather than a complete UX story.

Use this version if you value coordination and auditability in AI-assisted coding. If you only need a simpler single-agent loop, the fork may still be enough.
