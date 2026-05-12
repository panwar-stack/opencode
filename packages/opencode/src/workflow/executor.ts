import { Context, Effect, Layer, Option } from "effect"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { WorkflowArtifact } from "./artifact"
import { WorkflowScope } from "./scope"
import { WorkflowState, type WorkflowStateFile } from "./state"

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

function withCompletedTask(state: WorkflowStateFile, task: ParsedTask): WorkflowStateFile {
  return {
    ...state,
    completed_tasks: [...new Set([...(state.completed_tasks ?? []), task.id])],
    current_task: task.description,
    updated_at: WorkflowState.now(),
  }
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
  const plain = /(?<!`)\b([\w./-]+\.[a-zA-Z]{1,6})\b/g
  while ((m = plain.exec(description)) !== null) {
    refs.push(m[1])
  }
  return refs
}

function assertApprovedPlan(projectDir: string, workflowID: string): Effect.Effect<string, Error> {
  return Effect.gen(function* () {
    const state = yield* loadState(projectDir, workflowID)
    if (!state.approved_spec_hash) {
      return yield* Effect.fail(new Error("Workflow plan approval is missing an approved artifact hash."))
    }
    if (!state.plan_pull_request.number) {
      return yield* Effect.fail(new Error("Workflow plan approval is missing plan pull request metadata."))
    }
    return state.approved_spec_hash
  })
}

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

          const allowedPaths = WorkflowArtifact.parseAllowedPaths(impact)

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
            const session = yield* sessions.create({ agent: "build" })

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

            return { filesChanged, validationOk, validationOutput, unrecoverable: false, permissionDenied: false }
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

          if (!result.validationOk) {
            const next = WorkflowState.withState(state, "validating")
            yield* saveState(projectDir, next)
            yield* Effect.promise(() =>
              WorkflowArtifact.appendDecision(projectDir, workflowID, {
                action: "workflow.executor.validation_failed",
                previous_state: state.state,
                new_state: next.state,
                summary: `Validation failed for task ${task.id}: ${task.description}. ${result.validationOutput}`,
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
                previous_state: state.state,
                new_state: next.state,
                summary: `Scope drift detected for task ${task.id}: ${scopeReason}`,
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
          tasksCompleted = countChecked(state, tasks)
          yield* saveState(projectDir, state)

          yield* Effect.promise(() =>
            WorkflowArtifact.appendDecision(projectDir, workflowID, {
              action: "workflow.executor.task_completed",
              previous_state: state.state,
              new_state: state.state,
              summary: `Completed task ${task.id}: ${task.description}. Files changed: ${result.filesChanged.join(", ") || "none"}`,
              evidence: result.filesChanged.join(", "),
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
        const allowedPaths = WorkflowArtifact.parseAllowedPaths(impact)

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
          const session = yield* sessions.create({ agent: "build" })

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

          return { filesChanged, validationOk, validationOutput, unrecoverable: false, permissionDenied: false }
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

        const updated = withCompletedTask(state, task)
        yield* saveState(projectDir, updated)

        return {
          task_id: task.id,
          task_description: task.description,
          success: result.validationOk && scopeOk,
          files_changed: result.filesChanged,
          summary: result.validationOk
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
