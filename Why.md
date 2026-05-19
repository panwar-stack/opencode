# Why This Version

This version is for people who want opencode to handle larger, more review-heavy work with a bit more structure and memory.

It is not trying to claim the forked version is wrong or obsolete. The difference is focus. These changes move opencode from a mostly single-assistant workflow toward coordinated, inspectable AI-assisted development.

The biggest addition is experimental agent teams. A lead session can split work across named teammates, coordinate through messages and shared tasks, wait on dependencies, request plan approval, and produce a report afterward. That matters when a task is too broad for one linear chat loop.

This version also adds historical review memory. It can index GitHub PR review feedback and surface compact, cited lessons while coding or reviewing. The memory is advisory, not absolute. Current code, current instructions, and maintainer judgment still matter most. The goal is simply to reduce repeated mistakes and make project-specific expectations easier to reuse.

There are also smaller but useful improvements around visibility. Session exports include child session work, AI processing time is tracked more clearly, and team reports help explain what happened during a coordinated run. Built-in workflows like spec planning, initialization guidance, review memory, and team reporting make repeated engineering tasks easier to standardize.

Some of this is still early. Agent teams are experimental. Review memory currently starts with GitHub PR review comments. Team reports are operational signals, not proof of correctness. Multi-root session work is foundational rather than a complete UX story.

Use this version if you value coordination, review context, and auditability in AI-assisted coding. If you only need a simpler single-agent loop, the fork may still be enough.
