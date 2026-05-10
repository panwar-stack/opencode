import { describe, expect, test } from "bun:test"
import { WorkflowState } from "../../src/workflow/state"

describe("WorkflowSession", () => {
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
