import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { tmpdir } from "../fixture/fixture"
import { WorkflowExecutor } from "../../src/workflow/executor"
import { WorkflowScope } from "../../src/workflow/scope"
import { WorkflowApproval } from "../../src/workflow/approval"
import { WorkflowArtifact } from "../../src/workflow/artifact"
import { WorkflowState } from "../../src/workflow/state"

const executorLayer = WorkflowExecutor.defaultLayer
const runExecutor = <A, E>(effect: Effect.Effect<A, E, WorkflowExecutor.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(executorLayer)))

async function setupApprovedWorkflow(dir: string, workflowID: string) {
  const workflowDir = path.join(dir, ".opencode", "workflows", workflowID)
  await Bun.write(
    path.join(workflowDir, "IMPACT.md"),
    "# Impact\n\n## Allowed Paths\n\n- src/**\n",
    { createPath: true },
  )
  await Bun.write(
    path.join(workflowDir, "SPEC.md"),
    "# Test Spec\n\n## Summary\n\nTest workflow\n\n## Requirements\n\n- Do the thing\n",
    { createPath: true },
  )
  await Bun.write(
    path.join(workflowDir, "TASKS.md"),
    `# Tasks\n\n- [ ] First task\n- [x] Already done task\n- [ ] Second task\n- [ ] Third task\n`,
    { createPath: true },
  )
  const approvedHash = await WorkflowArtifact.hashApprovedArtifacts(dir, workflowID)
  await Bun.write(
    path.join(workflowDir, "GITHUB.md"),
    "# GitHub\n\nPlan review state: approved\n",
    { createPath: true },
  )
  await Bun.write(
    path.join(workflowDir, "DECISIONS.md"),
    "# Decisions\n\n## workflow.created\n\nCreated workflow.\n",
    { createPath: true },
  )
  await Bun.write(
    path.join(workflowDir, "STATE.json"),
    JSON.stringify({
      workflow_id: workflowID,
      title: "Test Workflow",
      state: "plan_approved",
      artifact_dir: `.opencode/workflows/${workflowID}`,
      created_at: WorkflowState.now(),
      updated_at: WorkflowState.now(),
      plan_branch: `opencode/workflow/${workflowID}-test-plan`,
      code_branch: `opencode/workflow/${workflowID}-test-code`,
      approved_spec_hash: approvedHash,
      approved_plan_commit: "abc123",
      plan_pull_request: {
        number: 42,
        url: "https://github.com/test/repo/pull/42",
        branch: `opencode/workflow/${workflowID}-test-plan`,
        head_commit: "abc123",
        review_state: "approved",
        comments: [],
      },
      code_pull_request: {
        review_state: "none",
        comments: [],
      },
      sessions: [],
    }),
    { createPath: true },
  )
  return approvedHash
}

describe("WorkflowExecutor", () => {
  test("runs execution loop completing unchecked tasks", async () => {
    await using tmp = await tmpdir({ git: true })
    const workflowID = "wf_test_exec"
    const approvedHash = await setupApprovedWorkflow(tmp.path, workflowID)

    const result = await runExecutor(
      WorkflowExecutor.Service.use((svc) => svc.run(tmp.path, workflowID)),
    )

    expect(result.workflow_id).toBe(workflowID)
    expect(result.stop_reason).toBe("all_tasks_complete")
    expect(result.tasks_total).toBe(4)
    expect(result.tasks_completed).toBe(4)

    const saved = await WorkflowArtifact.readState(tmp.path, workflowID)
    const tasksMd = await WorkflowArtifact.readArtifact(tmp.path, workflowID, "TASKS.md")
    expect(saved.completed_tasks).toEqual(["task_0", "task_2", "task_3"])
    expect(await WorkflowArtifact.hashApprovedArtifacts(tmp.path, workflowID)).toBe(approvedHash)
    expect(tasksMd).toContain("[ ] First task")
    expect(tasksMd).toContain("[x] Already done task")
    expect(tasksMd).toContain("[ ] Second task")
    expect(tasksMd).toContain("[ ] Third task")
  })

  test("stops execution on max_steps", async () => {
    await using tmp = await tmpdir({ git: true })
    const workflowID = "wf_test_max"
    await setupApprovedWorkflow(tmp.path, workflowID)

    const result = await runExecutor(
      WorkflowExecutor.Service.use((svc) => svc.run(tmp.path, workflowID, { max_steps: 1 })),
    )

    expect(result.stop_reason).toBe("max_steps_reached")
    expect(result.summary).toContain("Reached max steps")
  })

  test("refuses execution without approved plan", async () => {
    await using tmp = await tmpdir({ git: true })
    const workflowID = "wf_unapproved"
    const workflowDir = path.join(tmp.path, ".opencode", "workflows", workflowID)
    await Bun.write(
      path.join(workflowDir, "STATE.json"),
      JSON.stringify({
        workflow_id: workflowID,
        title: "Unapproved",
        state: "awaiting_plan_review",
        artifact_dir: `.opencode/workflows/${workflowID}`,
        created_at: WorkflowState.now(),
        updated_at: WorkflowState.now(),
        plan_branch: "test-branch",
        plan_pull_request: {
          review_state: "pending",
          comments: [],
        },
        code_pull_request: {
          review_state: "none",
          comments: [],
        },
        sessions: [],
      }),
      { createPath: true },
    )

    const error = await runExecutor(
      WorkflowExecutor.Service.use((svc) => svc.run(tmp.path, workflowID)),
    ).catch((e) => e)

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(/approv/i)
  })

  test("invalidates approved plan evidence when executor sees artifact drift", async () => {
    await using tmp = await tmpdir({ git: true })
    const workflowID = "wf_test_drift"
    await setupApprovedWorkflow(tmp.path, workflowID)
    await Bun.write(
      WorkflowArtifact.artifactPath(tmp.path, workflowID, "TASKS.md"),
      "# Tasks\n\n- [ ] Changed after approval\n",
    )

    const error = await runExecutor(
      WorkflowExecutor.Service.use((svc) => svc.run(tmp.path, workflowID)),
    ).catch((e) => e)
    const state = await WorkflowArtifact.readState(tmp.path, workflowID)
    const decisions = await Bun.file(WorkflowArtifact.artifactPath(tmp.path, workflowID, "DECISIONS.md")).text()

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain("changed after approval")
    expect(state.state).toBe("needs_amendment")
    expect(state.approved_spec_hash).toBeUndefined()
    expect(state.approved_plan_commit).toBeUndefined()
    expect(decisions).toContain("workflow.approved_plan.invalidated")
  })

  test("runs a single task by id", async () => {
    await using tmp = await tmpdir({ git: true })
    const workflowID = "wf_test_single"
    await setupApprovedWorkflow(tmp.path, workflowID)

    const result = await runExecutor(
      WorkflowExecutor.Service.use((svc) => svc.runTask(tmp.path, workflowID, "task_0")),
    )

    expect(result.task_id).toBe("task_0")
    expect(result.success).toBe(true)
    expect(result.task_description).toBe("First task")

    const state = await WorkflowArtifact.readState(tmp.path, workflowID)
    expect(state.completed_tasks).toContain("task_0")
  })

  test("returns already-completed result for checked task", async () => {
    await using tmp = await tmpdir({ git: true })
    const workflowID = "wf_test_checked"
    await setupApprovedWorkflow(tmp.path, workflowID)

    const result = await runExecutor(
      WorkflowExecutor.Service.use((svc) => svc.runTask(tmp.path, workflowID, "task_1")),
    )

    expect(result.task_id).toBe("task_1")
    expect(result.success).toBe(true)
    expect(result.summary).toBe("Task was already completed.")
  })

  test("stop sets the stop flag", async () => {
    await using tmp = await tmpdir({ git: true })
    const workflowID = "wf_test_stop"

    await setupApprovedWorkflow(tmp.path, workflowID)

    const result = await runExecutor(
      Effect.gen(function* () {
        const svc = yield* WorkflowExecutor.Service
        yield* svc.stop(workflowID)
        return yield* svc.run(tmp.path, workflowID, { max_steps: 100 })
      }),
    )

    expect(result.stop_reason).toBe("user_stopped")
  })

  test("pauses execution when open comments exist", async () => {
    await using tmp = await tmpdir({ git: true })
    const workflowID = "wf_test_comments"
    const approvedHash = await setupApprovedWorkflow(tmp.path, workflowID)

    const workflowDir = path.join(tmp.path, ".opencode", "workflows", workflowID)
    await Bun.write(
      path.join(workflowDir, "STATE.json"),
      JSON.stringify({
        workflow_id: workflowID,
        title: "Test Workflow",
        state: "plan_approved",
        artifact_dir: `.opencode/workflows/${workflowID}`,
        created_at: WorkflowState.now(),
        updated_at: WorkflowState.now(),
        plan_branch: `opencode/workflow/${workflowID}-test-plan`,
        code_branch: `opencode/workflow/${workflowID}-test-code`,
        approved_spec_hash: approvedHash,
        approved_plan_commit: "abc123",
        plan_pull_request: {
          number: 42,
          url: "https://github.com/test/repo/pull/42",
          branch: `opencode/workflow/${workflowID}-test-plan`,
          head_commit: "abc123",
          review_state: "approved",
          comments: [],
        },
        code_pull_request: {
          number: 43,
          url: "https://github.com/test/repo/pull/43",
          review_state: "commented",
          comments: [
            {
              id: "oc_1",
              body: "Please fix this.",
              state: "open",
              source: "review_comment",
            },
          ],
        },
        sessions: [],
      }),
    )

    const result = await runExecutor(
      WorkflowExecutor.Service.use((svc) => svc.run(tmp.path, workflowID)),
    )

    expect(result.stop_reason).toBe("unresolved_comments")
  })
})
