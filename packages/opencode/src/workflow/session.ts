import { Context, Effect, Layer } from "effect"
import { Bus } from "@/bus"
import { Workflow } from "./workflow"
import { WorkflowState, type SessionRole, type WorkflowSession, type ReviewComment } from "./state"
import { WorkflowEvents } from "./events"
import { WorkflowArtifact } from "./artifact"

export type SessionContext = {
  readonly workflow_id: string
  readonly title: string
  readonly state: string
  readonly session: WorkflowSession
  readonly artifacts: Record<string, string>
  readonly open_comments: readonly Pick<ReviewComment, "id" | "body" | "state">[]
  readonly allowed_paths: readonly string[]
}

export interface Interface {
  readonly createSession: (
    directory: string,
    workflowID: string,
    role: SessionRole,
    agent?: string,
  ) => Effect.Effect<WorkflowSession, Error>

  readonly listSessions: (
    directory: string,
    workflowID: string,
  ) => Effect.Effect<WorkflowSession[], Error>

  readonly getSession: (
    directory: string,
    workflowID: string,
    sessionID: string,
  ) => Effect.Effect<WorkflowSession, Error>

  readonly updateSession: (
    directory: string,
    workflowID: string,
    sessionID: string,
    updates: Partial<WorkflowSession>,
  ) => Effect.Effect<void, Error>

  readonly setActiveSession: (
    directory: string,
    workflowID: string,
    sessionID: string,
  ) => Effect.Effect<void, Error>

  readonly getSessionContext: (
    directory: string,
    workflowID: string,
    sessionID: string,
  ) => Effect.Effect<SessionContext, Error>

  readonly completeSession: (
    directory: string,
    workflowID: string,
    sessionID: string,
  ) => Effect.Effect<void, Error>

  readonly createRecoverySession: (
    directory: string,
    workflowID: string,
  ) => Effect.Effect<WorkflowSession, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowSession") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const workflow = yield* Workflow.Service
    const artifact = yield* WorkflowArtifact.Service

    const createSession = Effect.fn("WorkflowSession.createSession")(
      function* (directory: string, workflowID: string, role: SessionRole, _agent?: string) {
        const state = yield* workflow.get(directory, workflowID)
        const taskMap: Record<SessionRole, string> = {
          planner: "Draft workflow plan artifacts",
          plan_reviewer: "Review and approve workflow plan",
          executor: "Implement approved workflow plan",
          validator: "Validate implementation against plan",
          code_reviewer: "Review code pull request",
          amendment: "Process amendment request",
          recovery: "Recover interrupted workflow state",
        }
        const task = taskMap[role]

        const created = WorkflowState.now()
        const session: WorkflowSession = {
          id: WorkflowState.createSessionID(),
          role,
          status: "active",
          task,
          created_at: created,
          updated_at: created,
        }

        const next = WorkflowState.upsertSession(
          {
            ...state,
            current_task: task,
            updated_at: created,
          },
          session,
        )
        yield* artifact.writeState(directory, next)
        yield* artifact.writeGithubSummary(directory, next)

        yield* bus.publish(WorkflowEvents.SessionCreated, {
          workflow_id: workflowID,
          session_id: session.id,
          role,
        })

        return session
      },
    )

    const listSessions = Effect.fn("WorkflowSession.listSessions")(
      function* (directory: string, workflowID: string) {
        const state = yield* workflow.get(directory, workflowID)
        return [...workflow.sessions(state)]
      },
    )

    const getSession = Effect.fn("WorkflowSession.getSession")(
      function* (directory: string, workflowID: string, sessionID: string) {
        return yield* workflow.getSession(directory, workflowID, sessionID)
      },
    )

    const updateSession = Effect.fn("WorkflowSession.updateSession")(
      function* (
        directory: string,
        workflowID: string,
        sessionID: string,
        updates: Partial<WorkflowSession>,
      ) {
        const current = yield* workflow.getSession(directory, workflowID, sessionID)

        const updated: WorkflowSession = {
          ...current,
          ...updates,
          updated_at: WorkflowState.now(),
        }

        const state = yield* workflow.get(directory, workflowID)
        const next = WorkflowState.upsertSession(state, updated)
        yield* artifact.writeState(directory, next)
        yield* artifact.writeGithubSummary(directory, next)

        yield* bus.publish(WorkflowEvents.SessionUpdated, {
          workflow_id: workflowID,
          session_id: sessionID,
          role: updated.role,
          status: updated.status,
        })
      },
    )

    const setActiveSession = Effect.fn("WorkflowSession.setActiveSession")(
      function* (directory: string, workflowID: string, sessionID: string) {
        const state = yield* workflow.get(directory, workflowID)
        const next = WorkflowState.setActiveSession(state, sessionID)
        yield* artifact.writeState(directory, next)
        yield* artifact.writeGithubSummary(directory, next)
      },
    )

    const getSessionContext = Effect.fn("WorkflowSession.getSessionContext")(
      function* (directory: string, workflowID: string, sessionID: string) {
        const result = yield* workflow.sessionContext(directory, workflowID, sessionID)
        return {
          workflow_id: result.workflow.workflow_id,
          title: result.workflow.title,
          state: result.workflow.state,
          session: result.session,
          artifacts: result.artifacts,
          open_comments: result.open_comments.map((c) => ({ id: c.id, body: c.body, state: c.state })),
          allowed_paths: result.allowed_paths,
        }
      },
    )

    const completeSession = Effect.fn("WorkflowSession.completeSession")(
      function* (directory: string, workflowID: string, sessionID: string) {
        const state = yield* workflow.get(directory, workflowID)
        const session = yield* workflow.getSession(directory, workflowID, sessionID)
        const completed: WorkflowSession = {
          ...session,
          status: "completed",
          updated_at: WorkflowState.now(),
        }
        const next = WorkflowState.upsertSession(state, completed)
        yield* artifact.writeState(directory, next)
        yield* artifact.writeGithubSummary(directory, next)

        yield* bus.publish(WorkflowEvents.SessionUpdated, {
          workflow_id: workflowID,
          session_id: sessionID,
          role: completed.role,
          status: completed.status,
        })
      },
    )

    const createRecoverySession = Effect.fn("WorkflowSession.createRecoverySession")(
      function* (directory: string, workflowID: string) {
        const state = yield* workflow.get(directory, workflowID)
        const task = `Recover workflow from ${state.state}`
        const created = WorkflowState.now()
        const session: WorkflowSession = {
          id: WorkflowState.createSessionID(),
          role: "recovery",
          status: "active",
          task,
          created_at: created,
          updated_at: created,
        }
        const next = WorkflowState.upsertSession(
          { ...state, current_task: task, updated_at: created },
          session,
        )
        yield* artifact.writeState(directory, next)
        yield* artifact.writeGithubSummary(directory, next)
        yield* bus.publish(WorkflowEvents.SessionCreated, {
          workflow_id: workflowID,
          session_id: session.id,
          role: "recovery",
        })
        return session
      },
    )

    return Service.of({
      createSession,
      listSessions,
      getSession,
      updateSession,
      setActiveSession,
      getSessionContext,
      completeSession,
      createRecoverySession,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Workflow.defaultLayer),
)

export * as WorkflowSession from "./session"
