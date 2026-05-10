import { Context, Effect, Layer } from "effect"
import { WorkflowArtifact } from "./artifact"
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
      const match = line.trim().match(/^- \[(?<checked>[ x])\]\s+(?<description>.+)$/)
      if (!match) return undefined
      const task: ParsedTask = {
        id: `task_${taskIndex}`,
        description: match.groups!.description.trim(),
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

function hasOpenComments(state: WorkflowStateFile): boolean {
  return WorkflowState.openComments(state).length > 0
}

function assertApprovedPlan(projectDir: string, workflowID: string): Effect.Effect<string, Error> {
  return Effect.gen(function* () {
    const state = yield* loadState(projectDir, workflowID)
    if (!WorkflowState.isApprovedReview(state.plan_pull_request.review_state)) {
      return yield* Effect.fail(new Error("Workflow plan pull request must be approved before execution."))
    }
    if (!state.plan_pull_request.number) {
      return yield* Effect.fail(new Error("Workflow plan approval is missing plan pull request metadata."))
    }
    if (!state.approved_spec_hash) {
      return yield* Effect.fail(new Error("Workflow plan approval is missing an approved artifact hash."))
    }
    if (!state.approved_plan_commit || !state.plan_pull_request.head_commit) {
      return yield* Effect.fail(new Error("Workflow plan approval is missing approved head commit evidence."))
    }
    if (state.approved_plan_commit !== state.plan_pull_request.head_commit) {
      return yield* Effect.fail(new Error("Approved plan commit does not match the current plan pull request head."))
    }
    const hash = yield* Effect.promise(() =>
      WorkflowArtifact.hashApprovedArtifacts(projectDir, workflowID),
    )
    if (hash !== state.approved_spec_hash) {
      const next = WorkflowState.transitionOrCurrent(
        {
          ...state,
          approved_spec_hash: undefined,
          approved_plan_commit: undefined,
          user_input_needed: "Approved workflow artifacts changed after plan approval.",
          plan_pull_request: {
            ...state.plan_pull_request,
            review_state: "changes_requested",
            comments: [
              ...state.plan_pull_request.comments.filter((comment) => comment.id !== "local-approved-plan-drift"),
              {
                id: "local-approved-plan-drift",
                body: "Approved SPEC.md, TASKS.md, or IMPACT.md changed after plan approval. Re-approval is required before execution can continue.",
                state: "open",
                source: "review" as const,
                created_at: WorkflowState.now(),
                updated_at: WorkflowState.now(),
              },
            ],
          },
        },
        "needs_amendment",
      )
      yield* Effect.promise(() => WorkflowArtifact.writeState(projectDir, next))
      yield* Effect.promise(() =>
        WorkflowArtifact.appendDecision(projectDir, workflowID, {
          action: "workflow.approved_plan.invalidated",
          previous_state: state.state,
          new_state: next.state,
          summary: "Approved workflow artifacts changed after approval. Plan approval evidence was cleared.",
          evidence: state.approved_spec_hash,
          pull_request: state.plan_pull_request.number,
        }),
      )
      return yield* Effect.fail(
        new Error("Approved workflow artifacts changed after approval. Revise and re-approve the plan before execution."),
      )
    }
    return hash
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
    const activeStops = new Map<string, boolean>()

    const run = Effect.fn("WorkflowExecutor.run")(
      function* (projectDir: string, workflowID: string, config?: Partial<ExecutorConfig>) {
        const maxSteps = config?.max_steps ?? 100

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
          state = withCompletedTask(state, task)
          tasksCompleted = countChecked(state, tasks)
          yield* saveState(projectDir, state)

          yield* Effect.promise(() =>
            WorkflowArtifact.appendDecision(projectDir, workflowID, {
              action: "workflow.executor.task_completed",
              previous_state: state.state,
              new_state: state.state,
              summary: `Completed task ${task.id}: ${task.description}`,
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
        yield* assertApprovedPlan(projectDir, workflowID)

        const tasksMd = yield* loadTasks(projectDir, workflowID)
        const tasks = parseTASKS(tasksMd)
        const task = tasks.find((t) => t.id === taskID)
        if (!task) {
          return yield* Effect.fail(new Error(`Task not found: ${taskID}`))
        }

        if (taskCompleted(yield* loadState(projectDir, workflowID), task)) {
          return {
            task_id: task.id,
            task_description: task.description,
            success: true,
            files_changed: [],
            summary: "Task was already completed.",
          }
        }

        const state = yield* loadState(projectDir, workflowID)
        const next = withCompletedTask(state, task)
        yield* saveState(projectDir, next)

        yield* Effect.promise(() =>
          WorkflowArtifact.appendDecision(projectDir, workflowID, {
            action: "workflow.executor.task_ran",
            previous_state: state.state,
            new_state: next.state,
            summary: `Ran task ${task.id}: ${task.description}`,
          }),
        )

        return {
          task_id: task.id,
          task_description: task.description,
          success: true,
          files_changed: [],
          summary: `Task "${task.description}" marked complete.`,
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
