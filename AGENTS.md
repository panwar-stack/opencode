JavaScript SDK build script: ./packages/sdk/js/script/build.ts.
Main branch is master. Do not trust local main. Diff against master or origin/master.

Git titles: type(scope): words. Valid types: feat, fix, docs, chore, refactor, test.

Rules: think first, avoid guesses, state tradeoffs. Prefer the smallest safe fix. Touch only needed files. Clean only your own changes. Verify completion.

Style: one function unless reuse or clarity needs a name. No tiny one use helpers. No any. Avoid try and catch. Use Bun APIs such as Bun.file(). Let types infer. Export types only when needed. Prefer map, filter, flatMap, and filter guards. Inline one use values. Prefer dot access over needless destructuring. Use const, early return, and ternary. Avoid else when possible. Comment only weird or surprising rules. src/config uses self export: export * as ConfigAgent from "./agent".

Imports: no aliases or star imports. If namespace is needed, import the real exported namespace. Dynamic import heavy or branch only modules inside the branch, with destructuring near use.

Hard logic: keep main path readable. Put real validation or support concepts below. Keep sync parse, validate, and build logic sync. For untrusted JSON use Schema.UnknownFromJsonString or Schema.decodeUnknownOption, not hand JSON.parse inside Effect.try.

Drizzle: use snake_case fields. Prefer project_id: text().notNull() over renamed camel columns.

Tests: mock little. Test the real thing. Run tests from the package directory, not repo root. Run bun typecheck in the package directory. Do not run tsc directly.

Version 2 Session core:
SessionV2.prompt(...) only admits prompts and writes durable session_input, then calls advisory SessionExecution.wake(sessionID) unless resume is false.
Model execution stays separate from prompt admission.
Same Session ID adopts old Session. Same prompt ID is an exact retry only when Session, prompt, and delivery mode match.
SessionExecution is global per process and keyed by Session ID. Local drain resolves placement through SessionStore and LocationServiceMap.get(session.location).
Interrupt only the active local owner chain. Idle or missing interrupt is no op.
Runner, model, tools, permissions, and filesystem are Location scoped. Missing workspace means implicit local.
Use one llm.stream(request) per provider turn. Reload projected history before durable continue.
Do not bridge through legacy SessionPrompt.loop(...). Do not orchestrate tool loops in memory.
Local drains stay local to the process until clustering exists.
Coordinator joins same Session resumes, coalesces wakes, and lets different Sessions run together.
Advisory wake drains only eligible inbox items. Crash retry needs explicit design.
Delivery terms: default steer and coalesce at safe boundary. queue means future activity runs FIFO.
EventV2 replay claims are separate from clustered Session execution ownership.
System Context algebra, registry, and built ins live in src/system-context. Context Sources keep domains. Session owns history selection and Context Epoch persistence.