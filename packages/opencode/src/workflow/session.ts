import { Context, Effect, Layer, Option } from "effect"
import { Bus } from "@/bus"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
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

    const readOnlyPerm: Permission.Ruleset = [
      { permission: "edit", pattern: "**", action: "deny" },
      { permission: "write", pattern: "**", action: "deny" },
      { permission: "bash", pattern: "**", action: "deny" },
    ]

    const plannerPerm: Permission.Ruleset = [
      { permission: "edit", pattern: "**", action: "deny" },
      { permission: "write", pattern: "**", action: "deny" },
      { permission: "edit", pattern: ".opencode/workflows/**", action: "allow" },
      { permission: "write", pattern: ".opencode/workflows/**", action: "allow" },
    ]

    const executorPermissions = (allowedPaths: readonly string[]): Permission.Ruleset => {
      const rules: Permission.Ruleset = [
        { permission: "edit", pattern: "**", action: "deny" },
        { permission: "write", pattern: "**", action: "deny" },
      ]
      for (const p of allowedPaths) {
        rules.push(
          { permission: "edit", pattern: p, action: "allow" },
          { permission: "write", pattern: p, action: "allow" },
        )
      }
      return rules
    }

    const rolePermissions = (role: SessionRole): Permission.Ruleset => {
      switch (role) {
        case "planner":
          return plannerPerm
        case "plan_reviewer":
        case "validator":
        case "code_reviewer":
          return readOnlyPerm
        case "recovery":
          return []
        case "executor":
        case "amendment":
          // Derived from IMPACT.md at session creation time
          return []
      }
    }

    const createSession = Effect.fn("WorkflowSession.createSession")(
      function* (directory: string, workflowID: string, role: SessionRole, agent?: string) {
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

        let permission = rolePermissions(role)
        if (role === "executor" || role === "amendment") {
          const impact = yield* artifact.readArtifact(directory, workflowID, "IMPACT.md")
          const allowedPaths = WorkflowArtifact.parseAllowedPaths(impact)
          permission = executorPermissions(allowedPaths)
        }

        const sessionsOpt = yield* Effect.serviceOption(Session.Service)
        let sessionId = WorkflowState.createSessionID()
        if (Option.isSome(sessionsOpt)) {
          const realSession = yield* sessionsOpt.value.create({
            title: task,
            agent,
            permission,
          })
          sessionId = realSession.id
        }

        const created = WorkflowState.now()
        const session: WorkflowSession = {
          id: sessionId,
          role,
          status: "active",
          task,
          agent,
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

        const sessionsOpt = yield* Effect.serviceOption(Session.Service)
        let sessionId = WorkflowState.createSessionID()
        if (Option.isSome(sessionsOpt)) {
          const realSession = yield* sessionsOpt.value.create({
            title: task,
            permission: rolePermissions("recovery"),
          })
          sessionId = realSession.id
        }

        const created = WorkflowState.now()
        const session: WorkflowSession = {
          id: sessionId,
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
