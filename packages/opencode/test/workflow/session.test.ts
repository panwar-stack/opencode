import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Bus } from "../../src/bus"
import { Permission } from "../../src/permission"
import { Config } from "../../src/config/config"
import { Session } from "../../src/session/session"
import { ProjectID } from "../../src/project/schema"
import { SessionID } from "../../src/session/schema"
import { WorkflowArtifact } from "../../src/workflow/artifact"
import { WorkflowSession } from "../../src/workflow/session"
import { WorkflowState } from "../../src/workflow/state"
import { Workflow } from "../../src/workflow/workflow"
import { tmpdir } from "../fixture/fixture"

describe("WorkflowSession", () => {
  test("createSession expands allowed directories for executor permissions", async () => {
    await using tmp = await tmpdir({ git: true })
    const workflowID = "wf_test_session_permissions"
    const now = WorkflowState.now()
    const permissions: Permission.Ruleset[] = []

    await Bun.write(
      path.join(tmp.path, ".opencode", "workflows", workflowID, "IMPACT.md"),
      "# Impact\n\n## Allowed Paths\n\n- src/exact.ts\n\n## Allowed Directories\n\n- generated\n",
      { createPath: true },
    )
    await WorkflowArtifact.writeState(tmp.path, {
      workflow_id: workflowID,
      title: "Session permissions",
      state: "plan_approved",
      artifact_dir: `.opencode/workflows/${workflowID}`,
      created_at: now,
      updated_at: now,
      plan_branch: "plan",
      plan_pull_request: WorkflowState.emptyPullRequest(),
      code_pull_request: WorkflowState.emptyPullRequest(),
      sessions: [],
    })

    await Effect.runPromise(
      WorkflowSession.Service.use((svc) => svc.createSession(tmp.path, workflowID, "executor")).pipe(
        Effect.provide(WorkflowSession.defaultLayer),
        Effect.provide(WorkflowArtifact.defaultLayer),
        Effect.provide(Layer.mock(Bus.Service, { publish: () => Effect.void })),
        Effect.provide(
          Layer.mock(Session.Service, {
            create: (input) => {
              permissions.push(input?.permission ?? [])
              return Effect.succeed({
                id: "ses_test_session_permissions" as SessionID,
                slug: "session-permissions",
                projectID: "p_test_session_permissions" as ProjectID,
                directory: tmp.path,
                title: "executor",
                version: "0.0.0",
                time: { created: 0, updated: 0 },
              } satisfies Session.Info)
            },
          }),
        ),
      ),
    )

    expect(permissions[0]).toContainEqual({ permission: "write", pattern: "generated/**", action: "allow" })
    expect(Permission.evaluate("write", "generated/schema.ts", permissions[0]).action).toBe("allow")
    expect(Permission.evaluate("write", "src/exact.ts", permissions[0]).action).toBe("allow")
    expect(Permission.evaluate("write", "src/exact.ts/nested.ts", permissions[0]).action).toBe("deny")
  })

  test("createSession assigns role and task description", () => {
    const sessionID = WorkflowState.createSessionID()
    const created = WorkflowState.now()

    const session: WorkflowState.WorkflowSession = {
      id: sessionID,
      role: "plan_reviewer",
      status: "active",
      task: "Review plan PR for correctness",
      created_at: created,
      updated_at: created,
    }

    const state: WorkflowState.WorkflowStateFile = {
      workflow_id: "wf_test",
      title: "test",
      state: "drafting_spec",
      artifact_dir: ".opencode/workflows/wf_test",
      created_at: created,
      updated_at: created,
      plan_branch: "branch",
      plan_pull_request: WorkflowState.emptyPullRequest(),
      code_pull_request: WorkflowState.emptyPullRequest(),
      sessions: [
        {
          id: WorkflowState.createSessionID(),
          role: "planner",
          status: "active",
          task: "Draft plan",
          created_at: created,
          updated_at: created,
        },
      ],
    }

    const next = WorkflowState.upsertSession(state, session)
    expect(next.sessions).toHaveLength(2)
    expect(next.sessions[1]).toMatchObject({
      id: sessionID,
      role: "plan_reviewer",
      status: "active",
      task: "Review plan PR for correctness",
    })
  })

  test("listSessions returns all sessions ordered by creation", () => {
    const created = WorkflowState.now()

    const state: WorkflowState.WorkflowStateFile = {
      workflow_id: "wf_test",
      title: "test",
      state: "drafting_spec",
      artifact_dir: ".opencode/workflows/wf_test",
      created_at: created,
      updated_at: created,
      plan_branch: "branch",
      plan_pull_request: WorkflowState.emptyPullRequest(),
      code_pull_request: WorkflowState.emptyPullRequest(),
      sessions: [
        {
          id: "ses_1",
          role: "planner",
          status: "active",
          task: "Draft plan",
          created_at: created,
          updated_at: created,
        },
      ],
    }

    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0]).toMatchObject({
      role: "planner",
      status: "active",
    })
  })

  test("upsertSession adds new and updates existing", () => {
    const now = WorkflowState.now()

    const state: WorkflowState.WorkflowStateFile = {
      workflow_id: "wf_test",
      title: "test",
      state: "drafting_spec",
      artifact_dir: ".opencode/workflows/wf_test",
      created_at: now,
      updated_at: now,
      plan_branch: "branch",
      plan_pull_request: WorkflowState.emptyPullRequest(),
      code_pull_request: WorkflowState.emptyPullRequest(),
      sessions: [
        {
          id: "ses_1",
          role: "planner",
          status: "active",
          task: "Original task",
          created_at: now,
          updated_at: now,
        },
      ],
    }

    const updated = WorkflowState.updateSession(state, "ses_1", {
      status: "completed",
      task: "Updated task",
    })

    const session = updated.sessions.find((s) => s.id === "ses_1")
    expect(session).toMatchObject({
      id: "ses_1",
      role: "planner",
      status: "completed",
      task: "Updated task",
    })
  })

  test("setActiveSession updates the active session reference", () => {
    const now = WorkflowState.now()

    const state: WorkflowState.WorkflowStateFile = {
      workflow_id: "wf_test",
      title: "test",
      state: "drafting_spec",
      artifact_dir: ".opencode/workflows/wf_test",
      created_at: now,
      updated_at: now,
      plan_branch: "branch",
      active_session_id: "ses_1",
      plan_pull_request: WorkflowState.emptyPullRequest(),
      code_pull_request: WorkflowState.emptyPullRequest(),
      sessions: [
        {
          id: "ses_1",
          role: "planner",
          status: "completed",
          task: "Done",
          created_at: now,
          updated_at: now,
        },
        {
          id: "ses_2",
          role: "code_reviewer",
          status: "active",
          task: "Review code",
          created_at: now,
          updated_at: now,
        },
      ],
    }

    const next = WorkflowState.setActiveSession(state, "ses_2")
    expect(next.active_session_id).toBe("ses_2")
  })

  test("throws when setting active to a nonexistent session", () => {
    const now = WorkflowState.now()

    expect(() =>
      WorkflowState.setActiveSession(
        {
          workflow_id: "wf_test",
          title: "test",
          state: "drafting_spec",
          artifact_dir: ".opencode/workflows/wf_test",
          created_at: now,
          updated_at: now,
          plan_branch: "branch",
          plan_pull_request: WorkflowState.emptyPullRequest(),
          code_pull_request: WorkflowState.emptyPullRequest(),
          sessions: [],
        },
        "nonexistent",
      ),
    ).toThrow(/session not found/i)
  })

  test("throws when updating a nonexistent session", () => {
    const now = WorkflowState.now()

    expect(() =>
      WorkflowState.updateSession(
        {
          workflow_id: "wf_test",
          title: "test",
          state: "drafting_spec",
          artifact_dir: ".opencode/workflows/wf_test",
          created_at: now,
          updated_at: now,
          plan_branch: "branch",
          plan_pull_request: WorkflowState.emptyPullRequest(),
          code_pull_request: WorkflowState.emptyPullRequest(),
          sessions: [],
        },
        "nonexistent",
        { status: "completed" },
      ),
    ).toThrow(/session not found/i)
  })

  test("completeSession auto-submits plan only after planner completion", async () => {
    const now = WorkflowState.now()
    let submitCalls = 0
    let savedState: WorkflowState.WorkflowStateFile | undefined
    const state: WorkflowState.WorkflowStateFile = {
      workflow_id: "wf_test_auto_submit",
      title: "test",
      state: "drafting_spec",
      artifact_dir: ".opencode/workflows/wf_test_auto_submit",
      created_at: now,
      updated_at: now,
      plan_branch: "branch",
      plan_pull_request: WorkflowState.emptyPullRequest(),
      code_pull_request: WorkflowState.emptyPullRequest(),
      sessions: [
        {
          id: "ses_plan",
          role: "planner",
          status: "active",
          task: "Draft plan",
          created_at: now,
          updated_at: now,
        },
      ],
    }

    await Effect.runPromise(
      WorkflowSession.Service.use((svc) => svc.completeSession("/repo", state.workflow_id, "ses_plan")).pipe(
        Effect.provide(WorkflowSession.layer),
        Effect.provide(
          Layer.mock(Workflow.Service, {
            get: () => Effect.succeed(savedState ?? state),
            getSession: () => Effect.succeed(state.sessions[0]),
            submitPlan: () =>
              Effect.sync(() => {
                submitCalls++
                return savedState ?? state
              }),
            findSession: (workflowState, sessionID) => workflowState.sessions.find((session) => session.id === sessionID),
            sessions: (workflowState) => workflowState.sessions,
            branch: (workflowState) => ({ plan: workflowState.plan_branch, code: workflowState.code_branch }),
          }),
        ),
        Effect.provide(
          Layer.mock(WorkflowArtifact.Service, {
            writeState: (_directory, next) =>
              Effect.sync(() => {
                savedState = next
              }),
            writeGithubSummary: () => Effect.void,
          }),
        ),
        Effect.provide(Layer.mock(Bus.Service, { publish: () => Effect.void })),
        Effect.provideService(Config.Service, {
          get: () => Effect.succeed({ workflow: { auto_submit_plan: true } } as Config.Info),
          getGlobal: () => Effect.succeed({} as Config.Info),
          getConsoleState: () => Effect.succeed({} as any),
          update: () => Effect.void,
          updateGlobal: () => Effect.succeed({ info: {} as Config.Info, changed: false }),
          invalidate: () => Effect.void,
          directories: () => Effect.succeed([]),
          waitForDependencies: () => Effect.void,
        }),
      ),
    )

    expect(submitCalls).toBe(1)
    expect(savedState?.sessions).toEqual([expect.objectContaining({ id: "ses_plan", status: "completed" })])
  })

  test("session roles cover all workflow lifecycle phases", () => {
    const roles = WorkflowState.SessionRoles
    expect(roles).toContain("planner")
    expect(roles).toContain("plan_reviewer")
    expect(roles).toContain("executor")
    expect(roles).toContain("validator")
    expect(roles).toContain("code_reviewer")
    expect(roles).toContain("amendment")
    expect(roles).toContain("recovery")
  })

  test("upsertSession with active status sets active_session_id", () => {
    const now = WorkflowState.now()

    const state: WorkflowState.WorkflowStateFile = {
      workflow_id: "wf_test",
      title: "test",
      state: "drafting_spec",
      artifact_dir: ".opencode/workflows/wf_test",
      created_at: now,
      updated_at: now,
      plan_branch: "branch",
      plan_pull_request: WorkflowState.emptyPullRequest(),
      code_pull_request: WorkflowState.emptyPullRequest(),
      sessions: [],
    }

    const newSession: WorkflowState.WorkflowSession = {
      id: WorkflowState.createSessionID(),
      role: "executor",
      status: "active",
      task: "Implement changes",
      created_at: now,
      updated_at: now,
    }

    const next = WorkflowState.upsertSession(state, newSession)
    expect(next.active_session_id).toBe(newSession.id)
    expect(next.sessions).toHaveLength(1)
  })
})
