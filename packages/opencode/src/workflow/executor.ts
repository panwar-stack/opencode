import { Context, Effect, Layer, Option } from "effect"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { WorkflowArtifact } from "./artifact"
import { WorkflowScope } from "./scope"
import { WorkflowState, type WorkflowSession, type WorkflowStateFile } from "./state"
import type { ValidationResult } from "./artifact"

export type StopReason =
  | "all_tasks_complete"
  | "max_steps_reached"
  | "validation_failure"
  | "user_paused"
  | "scope_drift"
  | "permission_denied"
  | "unrecoverable_error"
  | "unresolved_comments"
  | "user_stopped"
  | "required_user_input"

export type ExecutionResult = {
  readonly workflow_id: string
  readonly state: WorkflowStateFile["state"]
  readonly tasks_completed: number
  readonly tasks_total: number
  readonly stop_reason: StopReason
  readonly summary: string
}

export type TaskResult = {
  readonly task_id: string
  readonly task_description: string
  readonly success: boolean
  readonly files_changed: readonly string[]
  readonly summary: string
}

export type ParsedTask = {
  readonly id: string
  readonly description: string
  readonly checked: boolean
  readonly line_index: number
  readonly github_comment_url?: string
}

export type ExecutorConfig = {
  readonly max_steps: number
}

function parseTASKS(tasksMd: string): ParsedTask[] {
  const lines = tasksMd.split(/\r?\n/)
  let taskIndex = 0
  return lines
    .map((line, lineIndex) => {
      const match = line.trim().match(/^- \[(?<checked>[ x])\]\s+(?<content>.+)$/)
      if (!match) return undefined
      const content = match.groups!.content.trim()
      const pipeIdx = content.indexOf("|")
      const id = pipeIdx >= 0 ? content.slice(0, pipeIdx).trim() : `task_${taskIndex}`
      const description = pipeIdx >= 0 ? content.slice(pipeIdx + 1).replace(/\|.*$/, "").trim() : content
      const task: ParsedTask = {
        id,
        description,
        checked: match.groups!.checked === "x",
        line_index: lineIndex,
        github_comment_url: content.match(/(?:^|\|)\s*github:\s*([^|]+)/i)?.[1]?.trim().replace(/^none$/, "") || undefined,
      }
      taskIndex++
      return task
    })
    .filter((task): task is ParsedTask => task !== undefined)
}

function taskCompleted(state: WorkflowStateFile, task: ParsedTask): boolean {
  return task.checked || (state.completed_tasks ?? []).includes(task.id)
}

function nextUncheckedTask(state: WorkflowStateFile, tasks: ParsedTask[]): ParsedTask | undefined {
  return tasks.find((task) => !taskCompleted(state, task))
}

function countChecked(state: WorkflowStateFile, tasks: ParsedTask[]): number {
  return tasks.filter((task) => taskCompleted(state, task)).length
}

function loadState(projectDir: string, workflowID: string): Effect.Effect<WorkflowStateFile> {
  return Effect.promise(() => WorkflowArtifact.readState(projectDir, workflowID))
}

function saveState(projectDir: string, state: WorkflowStateFile): Effect.Effect<void> {
  return Effect.promise(() => WorkflowArtifact.writeState(projectDir, state))
}

function loadTasks(projectDir: string, workflowID: string): Effect.Effect<string> {
  return Effect.promise(() => WorkflowArtifact.readArtifact(projectDir, workflowID, "TASKS.md"))
}

function saveTasks(projectDir: string, workflowID: string, tasksMd: string): Effect.Effect<void> {
  return Effect.promise(() => WorkflowArtifact.writeArtifact(projectDir, workflowID, "TASKS.md", tasksMd))
}

function replaceTaskMetadata(line: string, key: string, value: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`(^|\\|)\\s*${escaped}:\\s*[^|]+`, "i")
  if (pattern.test(line)) return line.replace(pattern, `$1 ${key}: ${value}`)
  return `${line} | ${key}: ${value}`
}

function updateTaskStatus(tasksMd: string, task: ParsedTask, input: { checked: boolean; status: string; evidence: string; github?: string }) {
  return tasksMd
    .split(/\r?\n/)
    .map((line, index) => {
      if (index !== task.line_index) return line
      const checked = line.replace(/^\s*-\s+\[[ x]\]/, `- [${input.checked ? "x" : " "}]`)
      return [
        ["status", input.status],
        ["evidence", input.evidence],
        ["github", input.github ?? task.github_comment_url ?? "none"],
      ].reduce((next, item) => replaceTaskMetadata(next, item[0], item[1]), checked)
    })
    .join("\n")
}

function withCompletedTask(state: WorkflowStateFile, task: ParsedTask): WorkflowStateFile {
  return {
    ...state,
    completed_tasks: [...new Set([...(state.completed_tasks ?? []), task.id])],
    current_task: task.description,
    updated_at: WorkflowState.now(),
  }
}

function withValidationSession(state: WorkflowStateFile, task: ParsedTask, validation: ValidationResult, sessionID: string): WorkflowStateFile {
  return WorkflowState.upsertSession(
    {
      ...state,
      last_validation: validation,
      updated_at: WorkflowState.now(),
    },
    {
      id: sessionID,
      role: "validator",
      status: validation.ok ? "completed" : "failed",
      task: `Validate task ${task.id}: ${task.description}`,
      agent: "validator",
      files_touched: validation.files,
      created_at: WorkflowState.now(),
      updated_at: WorkflowState.now(),
      github_comment_url: task.github_comment_url,
    },
  )
}

function taskEvidence(validation: ValidationResult, sessionID?: string) {
  return [sessionID ? `session ${sessionID}` : undefined, validation.summary, validation.files?.length ? `files: ${validation.files.join(", ")}` : undefined]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("; ")
}

function amendmentContent(reason: string, files: readonly string[]) {
  return [
    "# Amendment",
    "",
    "## Reason",
    "",
    reason,
    "",
    "## Scope Change",
    "",
    "Expand approved workflow impact boundary or revise the task to stay within the existing boundary.",
    "",
    "## Affected Files",
    "",
    ...files.map((file) => `- ${file}`),
    "",
    "## Approval Status",
    "",
    "pending",
    "",
    "## Created",
    "",
    WorkflowState.now(),
    "",
  ].join("\n")
}

function hasOpenComments(state: WorkflowStateFile): boolean {
  return WorkflowState.openComments(state).length > 0
}

function extractFileReferences(description: string): string[] {
  const backtick = /`([^`]+)`/g
  const refs: string[] = []
  let m: RegExpExecArray | null
  while ((m = backtick.exec(description)) !== null) {
    const inner = m[1].trim()
    if (/\.[a-zA-Z]{1,6}$/.test(inner) || inner.includes("/")) refs.push(inner)
  }
  const plain = /\b([\w./-]+\.[a-zA-Z]{1,6})\b/g
  const withoutBackticks = description.replace(/`[^`]+`/g, " ")
  while ((m = plain.exec(withoutBackticks)) !== null) {
    refs.push(m[1])
  }
  return refs
}

function assertApprovedPlan(projectDir: string, workflowID: string): Effect.Effect<string, Error> {
  return Effect.gen(function* () {
    const state = yield* loadState(projectDir, workflowID)
    if (!state.plan_pull_request.number) {
      return yield* Effect.fail(new Error("Workflow plan approval is missing plan pull request metadata."))
    }
    if (!WorkflowState.isApprovedReview(state.plan_pull_request.review_state)) {
      return yield* Effect.fail(new Error("Workflow plan pull request must be approved before execution."))
    }
    if (!state.approved_spec_hash) {
      return yield* Effect.fail(new Error("Workflow plan approval is missing an approved artifact hash."))
    }
    if (!state.approved_plan_commit || !state.plan_pull_request.head_commit) {
      return yield* Effect.fail(new Error("Workflow plan approval is missing approved head commit evidence."))
    }
    if (state.approved_plan_commit !== state.plan_pull_request.head_commit) {
      return yield* Effect.fail(new Error("Workflow plan approval head commit does not match the current plan pull request."))
    }
    const hash = yield* Effect.promise(() => WorkflowArtifact.hashApprovedArtifacts(projectDir, workflowID))
    if (hash !== state.approved_spec_hash) {
      return yield* Effect.fail(
        new Error("Approved workflow artifacts changed after approval. Revise and re-approve the plan before execution."),
      )
    }
    return state.approved_spec_hash
  })
}

const executorPermissions = (allowedPaths: readonly string[]): Permission.Ruleset => [
  { permission: "edit", pattern: "**", action: "deny" },
  { permission: "write", pattern: "**", action: "deny" },
  ...allowedPaths.flatMap((p) => [
    { permission: "edit" as const, pattern: WorkflowArtifact.permissionPatternForAllowedPath(p), action: "allow" as const },
    { permission: "write" as const, pattern: WorkflowArtifact.permissionPatternForAllowedPath(p), action: "allow" as const },
  ]),
]

export interface Interface {
  run: (projectDir: string, workflowID: string, config?: Partial<ExecutorConfig>) => Effect.Effect<ExecutionResult, Error>
  runTask: (projectDir: string, workflowID: string, taskID: string) => Effect.Effect<TaskResult, Error>
  stop: (workflowID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowExecutor") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const configOpt = yield* Effect.serviceOption(Config.Service)
    const wfMaxSteps = Option.isSome(configOpt) ? (yield* configOpt.value.get()).workflow?.max_steps ?? 10 : 10
    const wfChecks = Option.isSome(configOpt) ? (yield* configOpt.value.get()).workflow?.checks ?? ["bun typecheck"] : ["bun typecheck"]
    const activeStops = new Map<string, boolean>()

    const run = Effect.fn("WorkflowExecutor.run")(
      function* (projectDir: string, workflowID: string, config?: Partial<ExecutorConfig>) {
        const maxSteps = config?.max_steps ?? wfMaxSteps

        yield* assertApprovedPlan(projectDir, workflowID)

        let state = yield* loadState(projectDir, workflowID)
        const tasks = parseTASKS(yield* loadTasks(projectDir, workflowID))

        const tasksTotal = tasks.length
        let stepCount = 0
        let tasksCompleted = countChecked(state, tasks)

        const executingState = WorkflowState.withState(state, "executing")
        yield* saveState(projectDir, executingState)
        state = executingState

        yield* Effect.promise(() =>
          WorkflowArtifact.appendDecision(projectDir, workflowID, {
            action: "workflow.executor.started",
            previous_state: state.state,
            new_state: "executing",
            summary: `Executor loop started with ${tasksTotal} tasks, ${tasksCompleted} already completed.`,
          }),
        )

        while (stepCount < maxSteps) {
          state = yield* loadState(projectDir, workflowID)

          if (state.user_input_needed) {
            const next = WorkflowState.withState(state, "paused")
            yield* saveState(projectDir, next)
            yield* Effect.promise(() =>
              WorkflowArtifact.appendDecision(projectDir, workflowID, {
                action: "workflow.executor.user_input_needed",
                previous_state: state.state,
                new_state: next.state,
                summary: `Execution paused: ${state.user_input_needed}`,
              }),
            )
            return {
              workflow_id: workflowID,
              state: next.state,
              tasks_completed: tasksCompleted,
              tasks_total: tasksTotal,
              stop_reason: "required_user_input" as const,
              summary: `User input needed: ${state.user_input_needed}`,
            }
          }

          if (activeStops.get(workflowID)) {
            activeStops.delete(workflowID)
            return {
              workflow_id: workflowID,
              state: state.state,
              tasks_completed: tasksCompleted,
              tasks_total: tasksTotal,
              stop_reason: "user_stopped" as const,
              summary: "Execution stopped by user request.",
            }
          }

          const task = nextUncheckedTask(state, tasks)
          if (!task) {
            const next = WorkflowState.withState(state, "awaiting_code_review")
            yield* saveState(projectDir, next)
            yield* Effect.promise(() =>
              WorkflowArtifact.appendDecision(projectDir, workflowID, {
                action: "workflow.executor.completed",
                previous_state: state.state,
                new_state: next.state,
                summary: `All ${tasksTotal} tasks completed.`,
              }),
            )
            return {
              workflow_id: workflowID,
              state: next.state,
              tasks_completed: tasksCompleted,
              tasks_total: tasksTotal,
              stop_reason: "all_tasks_complete" as const,
              summary: `Completed all ${tasksTotal} tasks in ${stepCount} steps.`,
            }
          }

          if (hasOpenComments(state)) {
            const next = WorkflowState.withState(state, "awaiting_code_review")
            yield* saveState(projectDir, next)
            yield* Effect.promise(() =>
              WorkflowArtifact.appendDecision(projectDir, workflowID, {
                action: "workflow.executor.paused_comments",
                previous_state: state.state,
                new_state: next.state,
                summary: "Paused execution due to unresolved PR comments.",
              }),
            )
            return {
              workflow_id: workflowID,
              state: next.state,
              tasks_completed: tasksCompleted,
              tasks_total: tasksTotal,
              stop_reason: "unresolved_comments" as const,
              summary: `Paused at task "${task.description}" due to ${WorkflowState.openComments(state).length} unresolved comment(s).`,
            }
          }

          stepCount++

          const spec = yield* Effect.promise(() => WorkflowArtifact.readArtifact(projectDir, workflowID, "SPEC.md"))
          const impact = yield* Effect.promise(() => WorkflowArtifact.readArtifact(projectDir, workflowID, "IMPACT.md"))
          const tasksMd = yield* Effect.promise(() => WorkflowArtifact.readArtifact(projectDir, workflowID, "TASKS.md"))

          const allowedPaths = WorkflowArtifact.parseImpactAllowedPaths(impact)

          const fileRefs = extractFileReferences(task.description)
          const outOfScopeRef = fileRefs.find((ref) => !allowedPaths.some((allow) => WorkflowArtifact.matchesAllowedPath(ref, allow)))
          if (outOfScopeRef) {
            const reason = `Task description references file outside allowed paths: "${outOfScopeRef}" in task "${task.description}"`
            const next = {
              ...WorkflowState.withState(state, "needs_amendment"),
              user_input_needed: reason,
            }
            yield* Effect.promise(() =>
              WorkflowArtifact.writeArtifact(projectDir, workflowID, "AMENDMENT.md", amendmentContent(reason, [outOfScopeRef])),
            )
            yield* saveState(projectDir, next)
            yield* Effect.promise(() =>
              WorkflowArtifact.appendDecision(projectDir, workflowID, {
                action: "workflow.executor.scope_drift_task",
                previous_state: state.state,
                new_state: next.state,
                summary: reason,
              }),
            )
            return {
              workflow_id: workflowID,
              state: next.state,
              tasks_completed: tasksCompleted,
              tasks_total: tasksTotal,
              stop_reason: "scope_drift" as const,
              summary: `Task "${task.description}" references "${outOfScopeRef}" which is outside the allowed paths.`,
            }
          }

          const sessionsOpt = yield* Effect.serviceOption(Session.Service)
          const promptOpt = yield* Effect.serviceOption(SessionPrompt.Service)

          if (Option.isNone(sessionsOpt) || Option.isNone(promptOpt)) {
            const next = WorkflowState.withState(state, "failed")
            yield* saveState(projectDir, next)
            yield* Effect.promise(() =>
              WorkflowArtifact.appendDecision(projectDir, workflowID, {
                action: "workflow.executor.unrecoverable_error",
                previous_state: state.state,
                new_state: next.state,
                summary: "Workflow executor requires Session and SessionPrompt services for autonomous implementation. These are only available when opencode is running with the full service stack (not CLI-only mode).",
              }),
            )
            return {
              workflow_id: workflowID,
              state: next.state,
              tasks_completed: tasksCompleted,
              tasks_total: tasksTotal,
              stop_reason: "unrecoverable_error" as const,
              summary: "Workflow executor requires Session and SessionPrompt services for autonomous implementation. These are only available when opencode is running with the full service stack (not CLI-only mode).",
            }
          }

          const sessions = sessionsOpt.value
          const sessionPrompt = promptOpt.value

          const taskPrompt = [
            "You are an autonomous workflow executor. Implement the following task from an approved workflow plan.",
            "",
            "## Task",
            `**ID**: ${task.id}`,
            `**Description**: ${task.description}`,
            "",
            "## Approved Specification (SPEC.md)",
            spec,
            "",
            "## Impact Boundary (IMPACT.md)",
            impact,
            "",
            "## Allowed Paths",
            allowedPaths.length > 0 ? allowedPaths.map((p) => `- \`${p}\``).join("\n") : "(none defined — all paths restricted)",
            "",
            "## Task List (TASKS.md)",
            tasksMd,
            "",
            "## Instructions",
            "- Implement ONLY this specific task — do NOT implement other tasks in the list",
            "- Stay strictly within the allowed paths listed above",
            "- Do NOT modify files outside the approved impact boundary",
            "- After implementation, verify your changes work by running tests or typecheck",
            "- Use tools like read, write, edit, and bash to explore and modify the codebase",
            "- Record what files you changed and why",
          ].join("\n")

          const result = yield* Effect.gen(function* () {
            const session = yield* sessions.create({ agent: "build", permission: executorPermissions(allowedPaths) })

            state = WorkflowState.upsertSession(state, {
              id: session.id,
              role: "executor",
              status: "active",
              task: task.description,
              agent: "build",
              created_at: WorkflowState.now(),
              updated_at: WorkflowState.now(),
            })
            yield* saveState(projectDir, state)

            yield* sessionPrompt.prompt({
              sessionID: session.id,
              agent: "build",
              parts: [{ type: "text", text: taskPrompt }],
            })

            const filesChanged = yield* Effect.promise(async () => {
              const proc = Bun.spawn(["git", "diff", "--name-only", "HEAD"], {
                cwd: projectDir,
                stdout: "pipe",
                stderr: "pipe",
              })
              const out = await new Response(proc.stdout).text()
              return out.trim().split(/\r?\n/).filter(Boolean)
            }).pipe(Effect.catch(() => Effect.succeed([] as string[])))

            const checks = wfChecks
            let validationOk = true
            let validationOutput = ""
            for (const checkCmd of checks) {
              const checkResult = yield* Effect.promise(async () => {
                const parts = checkCmd.split(/\s+/)
                const proc = Bun.spawn(parts, {
                  cwd: projectDir,
                  stdout: "pipe",
                  stderr: "pipe",
                })
                const [stdout, stderr] = await Promise.all([
                  new Response(proc.stdout).text(),
                  new Response(proc.stderr).text(),
                ])
                const exitCode = await proc.exited
                return { ok: exitCode === 0, output: (stdout + stderr).trim() }
              }).pipe(Effect.catch(() => Effect.succeed({ ok: false, output: `Failed to run check: ${checkCmd}` })))
              if (!checkResult.ok) {
                validationOk = false
                validationOutput = `${checkCmd}: ${checkResult.output}`
                break
              }
            }

            return { filesChanged, validationOk, validationOutput, unrecoverable: false, permissionDenied: false, sessionId: session.id }
          }).pipe(
            Effect.catch((cause) => {
              const msg = String(cause).toLowerCase()
              const denied = msg.includes("permission") || msg.includes("denied") || msg.includes("eacces")
              return Effect.succeed({
                filesChanged: [] as string[],
                validationOk: false,
                validationOutput: String(cause),
                unrecoverable: !denied,
                permissionDenied: denied,
                sessionId: "",
              })
            }),
          )

          let scopeOk = true
          let scopeReason = ""
          if (result.filesChanged.length > 0) {
            const maybeScope = yield* Effect.serviceOption(WorkflowScope.Service)
            if (Option.isSome(maybeScope)) {
              const driftResult = yield* maybeScope.value.checkEdit(projectDir, workflowID, [...result.filesChanged])
              scopeOk = driftResult.allowed
              scopeReason = driftResult.reason
            }
          }

          if (result.permissionDenied) {
            if (result.sessionId) {
              const existing = state.sessions.find((s) => s.id === result.sessionId)
              if (existing) state = WorkflowState.upsertSession(state, { ...existing, status: "failed", files_touched: result.filesChanged, updated_at: WorkflowState.now() })
            }
            const next = WorkflowState.withState(state, "paused")
            yield* saveState(projectDir, next)
            yield* Effect.promise(() =>
              WorkflowArtifact.appendDecision(projectDir, workflowID, {
                action: "workflow.executor.permission_denied",
                previous_state: state.state,
                new_state: next.state,
                summary: `Permission denied for task ${task.id}: ${result.validationOutput}`,
              }),
            )
            return {
              workflow_id: workflowID,
              state: next.state,
              tasks_completed: tasksCompleted,
              tasks_total: tasksTotal,
              stop_reason: "permission_denied" as const,
              summary: `Permission denied during task "${task.description}": ${result.validationOutput}`,
            }
          }

          if (result.unrecoverable) {
            if (result.sessionId) {
              const existing = state.sessions.find((s) => s.id === result.sessionId)
              if (existing) state = WorkflowState.upsertSession(state, { ...existing, status: "failed", files_touched: result.filesChanged, updated_at: WorkflowState.now() })
            }
            const next = WorkflowState.withState(state, "failed")
            yield* saveState(projectDir, next)
            yield* Effect.promise(() =>
              WorkflowArtifact.appendDecision(projectDir, workflowID, {
                action: "workflow.executor.unrecoverable_error",
                previous_state: state.state,
                new_state: next.state,
                summary: `Unrecoverable error for task ${task.id}: ${result.validationOutput}`,
              }),
            )
            return {
              workflow_id: workflowID,
              state: next.state,
              tasks_completed: tasksCompleted,
              tasks_total: tasksTotal,
              stop_reason: "unrecoverable_error" as const,
              summary: `Unrecoverable error during task "${task.description}": ${result.validationOutput}`,
            }
          }

          const validation: ValidationResult = {
            ok: result.validationOk && scopeOk,
            checked_at: WorkflowState.now(),
            summary: result.validationOk
              ? scopeOk
                ? `Validation passed for task ${task.id}: ${task.description}.`
                : `Scope drift detected for task ${task.id}: ${scopeReason}`
              : `Validation failed for task ${task.id}: ${task.description}. ${result.validationOutput}`,
            files: result.filesChanged,
            allowed_paths: allowedPaths,
          }
          const validatorSessionID = WorkflowState.createSessionID()
          state = withValidationSession(state, task, validation, validatorSessionID)

          if (!result.validationOk) {
            if (result.sessionId) {
              const existing = state.sessions.find((s) => s.id === result.sessionId)
              if (existing) state = WorkflowState.upsertSession(state, { ...existing, status: "failed", files_touched: result.filesChanged, updated_at: WorkflowState.now() })
            }
            yield* saveTasks(projectDir, workflowID, updateTaskStatus(tasksMd, task, { checked: false, status: "failed", evidence: taskEvidence(validation, result.sessionId) }))
            const next = WorkflowState.withState(state, "validating")
            yield* saveState(projectDir, next)
            yield* Effect.promise(() =>
              WorkflowArtifact.appendDecision(projectDir, workflowID, {
                action: "workflow.executor.validation_failed",
                session_id: validatorSessionID,
                previous_state: state.state,
                new_state: next.state,
                summary: validation.summary,
                evidence: taskEvidence(validation, result.sessionId),
                github_comment_url: task.github_comment_url,
              }),
            )
            return {
              workflow_id: workflowID,
              state: next.state,
              tasks_completed: tasksCompleted,
              tasks_total: tasksTotal,
              stop_reason: "validation_failure" as const,
              summary: `Validation failed after task "${task.description}": ${result.validationOutput}`,
            }
          }

          if (!scopeOk) {
            if (result.sessionId) {
              const existing = state.sessions.find((s) => s.id === result.sessionId)
              if (existing) state = WorkflowState.upsertSession(state, { ...existing, status: "failed", files_touched: result.filesChanged, updated_at: WorkflowState.now() })
            }
            yield* saveTasks(projectDir, workflowID, updateTaskStatus(tasksMd, task, { checked: false, status: "blocked", evidence: taskEvidence(validation, result.sessionId) }))
            const next = {
              ...WorkflowState.withState(state, "needs_amendment"),
              user_input_needed: scopeReason,
            }
            yield* Effect.promise(() =>
              WorkflowArtifact.writeArtifact(projectDir, workflowID, "AMENDMENT.md", amendmentContent(scopeReason, result.filesChanged)),
            )
            yield* saveState(projectDir, next)
            yield* Effect.promise(() =>
              WorkflowArtifact.appendDecision(projectDir, workflowID, {
                action: "workflow.executor.scope_drift",
                session_id: validatorSessionID,
                previous_state: state.state,
                new_state: next.state,
                summary: validation.summary,
                evidence: taskEvidence(validation, result.sessionId),
                github_comment_url: task.github_comment_url,
              }),
            )
            return {
              workflow_id: workflowID,
              state: next.state,
              tasks_completed: tasksCompleted,
              tasks_total: tasksTotal,
              stop_reason: "scope_drift" as const,
              summary: `Scope drift after task "${task.description}": ${scopeReason}`,
            }
          }

          state = withCompletedTask(state, task)
          if (result.sessionId) {
            const existing = state.sessions.find((s) => s.id === result.sessionId)
            if (existing) state = WorkflowState.upsertSession(state, { ...existing, status: "completed", files_touched: result.filesChanged, updated_at: WorkflowState.now() })
          }
          tasksCompleted = countChecked(state, tasks)
          yield* saveTasks(projectDir, workflowID, updateTaskStatus(tasksMd, task, { checked: true, status: "completed", evidence: taskEvidence(validation, result.sessionId) }))
          yield* saveState(projectDir, state)

          yield* Effect.promise(() =>
            WorkflowArtifact.appendDecision(projectDir, workflowID, {
              action: "workflow.executor.task_completed",
              session_id: validatorSessionID,
              previous_state: state.state,
              new_state: state.state,
              summary: `Completed task ${task.id}: ${task.description}. Files changed: ${result.filesChanged.join(", ") || "none"}`,
              evidence: taskEvidence(validation, result.sessionId),
              github_comment_url: task.github_comment_url,
            }),
          )
        }

        const next = WorkflowState.withState(state, "awaiting_code_review")
        yield* saveState(projectDir, next)
        yield* Effect.promise(() =>
          WorkflowArtifact.appendDecision(projectDir, workflowID, {
            action: "workflow.executor.max_steps",
            previous_state: state.state,
            new_state: next.state,
            summary: `Reached max steps (${maxSteps}). ${tasksCompleted}/${tasksTotal} tasks completed.`,
          }),
        )
        return {
          workflow_id: workflowID,
          state: next.state,
          tasks_completed: tasksCompleted,
          tasks_total: tasksTotal,
          stop_reason: "max_steps_reached" as const,
          summary: `Reached max steps (${maxSteps}). ${tasksCompleted}/${tasksTotal} tasks completed.`,
        }
      },
    )

    const runTask = Effect.fn("WorkflowExecutor.runTask")(
      function* (projectDir: string, workflowID: string, taskID: string) {
        const state = yield* loadState(projectDir, workflowID)

        const tasksMd = yield* loadTasks(projectDir, workflowID)
        const tasks = parseTASKS(tasksMd)
        const task = tasks.find((t) => t.id === taskID)
        if (!task) {
          return yield* Effect.fail(new Error(`Task not found: ${taskID}`))
        }

        if (taskCompleted(state, task)) {
          return {
            task_id: task.id,
            task_description: task.description,
            success: true,
            files_changed: [],
            summary: "Task was already completed.",
          }
        }

        const spec = yield* Effect.promise(() => WorkflowArtifact.readArtifact(projectDir, workflowID, "SPEC.md"))
        const impact = yield* Effect.promise(() => WorkflowArtifact.readArtifact(projectDir, workflowID, "IMPACT.md"))
        const allowedPaths = WorkflowArtifact.parseImpactAllowedPaths(impact)

        const fileRefs = extractFileReferences(task.description)
        const outOfScopeRef = fileRefs.find((ref) => !allowedPaths.some((allow) => WorkflowArtifact.matchesAllowedPath(ref, allow)))
        if (outOfScopeRef) {
          return yield* Effect.fail(
            new Error(`Task description references file outside allowed paths: "${outOfScopeRef}" in task "${task.description}"`),
          )
        }

        const sessionsOpt = yield* Effect.serviceOption(Session.Service)
        const promptOpt = yield* Effect.serviceOption(SessionPrompt.Service)

        if (Option.isNone(sessionsOpt) || Option.isNone(promptOpt)) {
          return yield* Effect.fail(
            new Error("Workflow executor requires Session and SessionPrompt services for autonomous implementation. These are only available when opencode is running with the full service stack (not CLI-only mode)."),
          )
        }

        const sessions = sessionsOpt.value
        const sessionPrompt = promptOpt.value

        const taskPrompt = [
          "You are an autonomous workflow executor. Implement the following task from an approved workflow plan.",
          "",
          "## Task",
          `**ID**: ${task.id}`,
          `**Description**: ${task.description}`,
          "",
          "## Approved Specification (SPEC.md)",
          spec,
          "",
          "## Impact Boundary (IMPACT.md)",
          impact,
          "",
          "## Allowed Paths",
          allowedPaths.length > 0 ? allowedPaths.map((p) => `- \`${p}\``).join("\n") : "(none defined — all paths restricted)",
          "",
          "## Task List (TASKS.md)",
          tasksMd,
          "",
          "## Instructions",
          "- Implement ONLY this specific task — do NOT implement other tasks in the list",
          "- Stay strictly within the allowed paths listed above",
          "- Do NOT modify files outside the approved impact boundary",
          "- After implementation, verify your changes work by running tests or typecheck",
          "- Use tools like read, write, edit, and bash to explore and modify the codebase",
          "- Record what files you changed and why",
        ].join("\n")

        const result = yield* Effect.gen(function* () {
          const session = yield* sessions.create({ agent: "build", permission: executorPermissions(allowedPaths) })

          const withSession = WorkflowState.upsertSession(state, {
            id: session.id,
            role: "executor",
            status: "active",
            task: task.description,
            agent: "build",
            created_at: WorkflowState.now(),
            updated_at: WorkflowState.now(),
          })
          yield* saveState(projectDir, withSession)

          yield* sessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: taskPrompt }],
          })

          const filesChanged = yield* Effect.promise(async () => {
            const proc = Bun.spawn(["git", "diff", "--name-only", "HEAD"], {
              cwd: projectDir,
              stdout: "pipe",
              stderr: "pipe",
            })
            const out = await new Response(proc.stdout).text()
            return out.trim().split(/\r?\n/).filter(Boolean)
          }).pipe(Effect.catch(() => Effect.succeed([] as string[])))

          const checks = wfChecks
          let validationOk = true
          let validationOutput = ""
          for (const checkCmd of checks) {
            const checkResult = yield* Effect.promise(async () => {
              const parts = checkCmd.split(/\s+/)
              const proc = Bun.spawn(parts, {
                cwd: projectDir,
                stdout: "pipe",
                stderr: "pipe",
              })
              const [stdout, stderr] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
              ])
              const exitCode = await proc.exited
              return { ok: exitCode === 0, output: (stdout + stderr).trim() }
            }).pipe(Effect.catch(() => Effect.succeed({ ok: false, output: `Failed to run check: ${checkCmd}` })))
            if (!checkResult.ok) {
              validationOk = false
              validationOutput = `${checkCmd}: ${checkResult.output}`
              break
            }
          }

          return { filesChanged, validationOk, validationOutput, unrecoverable: false, permissionDenied: false, sessionId: session.id }
        }).pipe(
          Effect.catch((cause) => {
            const msg = String(cause).toLowerCase()
            const denied = msg.includes("permission") || msg.includes("denied") || msg.includes("eacces")
            return Effect.succeed({
              filesChanged: [] as string[],
              validationOk: false,
              validationOutput: String(cause),
              unrecoverable: !denied,
              permissionDenied: denied,
              sessionId: "",
            })
          }),
        )

        let scopeOk = true
        let scopeReason = ""
        if (result.filesChanged.length > 0) {
          const maybeScope = yield* Effect.serviceOption(WorkflowScope.Service)
          if (Option.isSome(maybeScope)) {
            const driftResult = yield* maybeScope.value.checkEdit(projectDir, workflowID, [...result.filesChanged])
            scopeOk = driftResult.allowed
            scopeReason = driftResult.reason
          }
        }

        if (result.unrecoverable) {
          return {
            task_id: task.id,
            task_description: task.description,
            success: false,
            files_changed: result.filesChanged,
            summary: `Unrecoverable error: ${result.validationOutput}`,
          }
        }

        const validation: ValidationResult = {
          ok: result.validationOk && scopeOk,
          checked_at: WorkflowState.now(),
          summary: result.validationOk
            ? scopeOk
              ? `Validation passed for task ${task.id}: ${task.description}.`
              : `Scope drift detected for task ${task.id}: ${scopeReason}`
            : `Validation failed for task ${task.id}: ${task.description}. ${result.validationOutput}`,
          files: result.filesChanged,
          allowed_paths: allowedPaths,
        }
        const validatorSessionID = WorkflowState.createSessionID()
        const updated = validation.ok ? withCompletedTask(state, task) : state
        const withValidator = withValidationSession(updated, task, validation, validatorSessionID)
        const final = result.sessionId
          ? WorkflowState.upsertSession(withValidator, {
              id: result.sessionId,
              role: "executor",
              status: result.validationOk && scopeOk ? "completed" : "failed",
              task: task.description,
              agent: "build",
              files_touched: result.filesChanged,
              created_at: updated.sessions.find((s) => s.id === result.sessionId)?.created_at ?? WorkflowState.now(),
              updated_at: WorkflowState.now(),
            })
          : withValidator
        yield* saveTasks(projectDir, workflowID, updateTaskStatus(tasksMd, task, { checked: validation.ok, status: validation.ok ? "completed" : scopeOk ? "failed" : "blocked", evidence: taskEvidence(validation, result.sessionId) }))
        yield* saveState(projectDir, final)
        yield* Effect.promise(() =>
          WorkflowArtifact.appendDecision(projectDir, workflowID, {
            action: validation.ok ? "workflow.executor.task_completed" : scopeOk ? "workflow.executor.validation_failed" : "workflow.executor.scope_drift",
            session_id: validatorSessionID,
            previous_state: state.state,
            new_state: final.state,
            summary: validation.summary,
            evidence: taskEvidence(validation, result.sessionId),
            github_comment_url: task.github_comment_url,
          }),
        )

        return {
          task_id: task.id,
          task_description: task.description,
          success: validation.ok,
          files_changed: result.filesChanged,
          summary: validation.ok
            ? scopeOk
              ? `Task executed: ${task.description}`
              : `Task executed: ${task.description}. Scope drift: ${scopeReason}`
            : `Task executed: ${task.description}. Validation failed: ${result.validationOutput}`,
        }
      },
    )

    const stop = Effect.fn("WorkflowExecutor.stop")(function* (workflowID: string) {
      activeStops.set(workflowID, true)
    })

    return Service.of({
      run,
      runTask,
      stop,
    })
  }),
)

export const defaultLayer = layer

export * as WorkflowExecutor from "./executor"
