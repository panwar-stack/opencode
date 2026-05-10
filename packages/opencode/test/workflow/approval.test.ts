import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { tmpdir } from "../fixture/fixture"
import { WorkflowApproval, type PlanApprovalEvidence, type CodeApprovalEvidence } from "../../src/workflow/approval"
import { WorkflowArtifact } from "../../src/workflow/artifact"
import { WorkflowState } from "../../src/workflow/state"

const runApproval = <A, E>(effect: Effect.Effect<A, E, WorkflowApproval.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(WorkflowApproval.defaultLayer)))

async function setupWorkflow(dir: string, workflowID: string) {
  const workflowDir = path.join(dir, ".opencode", "workflows", workflowID)
  await Bun.write(
    path.join(workflowDir, "IMPACT.md"),
    "# Impact\n\n## Allowed Paths\n\n- src/**\n",
    { createPath: true },
  )
  await Bun.write(
    path.join(workflowDir, "SPEC.md"),
    "# Test Spec\n\n## Summary\n\nTest\n",
    { createPath: true },
  )
  await Bun.write(
    path.join(workflowDir, "TASKS.md"),
    "# Tasks\n\n- [ ] Task 1\n",
    { createPath: true },
  )
  const approvedHash = await WorkflowArtifact.hashApprovedArtifacts(dir, workflowID)
  await Bun.write(
    path.join(workflowDir, "GITHUB.md"),
    "# GitHub\n\nPlan review state: pending\n",
    { createPath: true },
  )
  await Bun.write(
    path.join(workflowDir, "DECISIONS.md"),
    "# Decisions\n\n",
    { createPath: true },
  )
  await Bun.write(
    path.join(workflowDir, "STATE.json"),
    JSON.stringify({
      workflow_id: workflowID,
      title: "Test Workflow",
      state: "awaiting_plan_review",
      artifact_dir: `.opencode/workflows/${workflowID}`,
      created_at: WorkflowState.now(),
      updated_at: WorkflowState.now(),
      plan_branch: `opencode/workflow/${workflowID}-plan`,
      code_branch: `opencode/workflow/${workflowID}-code`,
      approved_spec_hash: undefined,
      approved_plan_commit: undefined,
      plan_pull_request: {
        number: 99,
        url: "https://github.com/test/repo/pull/99",
        branch: `opencode/workflow/${workflowID}-plan`,
        head_commit: "abc123",
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
  return approvedHash
}

describe("WorkflowApproval", () => {
  test("records and checks plan approval", async () => {
    await using tmp = await tmpdir({ git: true })
    const workflowID = "wf_plan_approve"
    const approvedHash = await setupWorkflow(tmp.path, workflowID)

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
        plan_branch: `opencode/workflow/${workflowID}-plan`,
        code_branch: `opencode/workflow/${workflowID}-code`,
        approved_spec_hash: approvedHash,
        approved_plan_commit: "abc123",
        plan_pull_request: {
          number: 99,
          url: "https://github.com/test/repo/pull/99",
          branch: `opencode/workflow/${workflowID}-plan`,
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
    )

    const status = await runApproval(
      WorkflowApproval.Service.use((svc) => svc.checkPlanApproval(tmp.path, workflowID)),
    )

    expect(status.tag).toBe("approved")
    if (status.tag === "approved") {
      const evidence = status.evidence as PlanApprovalEvidence
      expect(evidence.pull_request_number).toBe(99)
    }
  })

  test("returns pending when plan is not yet reviewed", async () => {
    await using tmp = await tmpdir({ git: true })
    const workflowID = "wf_pending"
    await setupWorkflow(tmp.path, workflowID)

    const status = await runApproval(
      WorkflowApproval.Service.use((svc) => svc.checkPlanApproval(tmp.path, workflowID)),
    )

    expect(status.tag).toBe("pending")
  })

  test("checks code approval status", async () => {
    await using tmp = await tmpdir({ git: true })
    const workflowID = "wf_code_rv"
    await setupWorkflow(tmp.path, workflowID)

    const workflowDir = path.join(tmp.path, ".opencode", "workflows", workflowID)
    await Bun.write(
      path.join(workflowDir, "STATE.json"),
      JSON.stringify({
        workflow_id: workflowID,
        title: "Test Workflow",
        state: "executing",
        artifact_dir: `.opencode/workflows/${workflowID}`,
        created_at: WorkflowState.now(),
        updated_at: WorkflowState.now(),
        plan_branch: `opencode/workflow/${workflowID}-plan`,
        code_branch: `opencode/workflow/${workflowID}-code`,
        plan_pull_request: {
          number: 99,
          url: "https://github.com/test/repo/pull/99",
          branch: `opencode/workflow/${workflowID}-plan`,
          head_commit: "abc123",
          review_state: "approved",
          comments: [],
        },
        code_pull_request: {
          number: 100,
          url: "https://github.com/test/repo/pull/100",
          review_state: "changes_requested",
          comments: [],
        },
        sessions: [],
      }),
    )

    const status = await runApproval(
      WorkflowApproval.Service.use((svc) => svc.checkCodeApproval(tmp.path, workflowID)),
    )

    expect(status.tag).toBe("rejected")
  })

  test("creates, approves, and rejects amendments", async () => {
    await using tmp = await tmpdir({ git: true })
    const workflowID = "wf_amend"
    const approvedHash = await setupWorkflow(tmp.path, workflowID)

    const workflowDir = path.join(tmp.path, ".opencode", "workflows", workflowID)
    await Bun.write(
      path.join(workflowDir, "STATE.json"),
      JSON.stringify({
        workflow_id: workflowID,
        title: "Test Workflow",
        state: "executing",
        artifact_dir: `.opencode/workflows/${workflowID}`,
        created_at: WorkflowState.now(),
        updated_at: WorkflowState.now(),
        plan_branch: `opencode/workflow/${workflowID}-plan`,
        code_branch: `opencode/workflow/${workflowID}-code`,
        approved_spec_hash: approvedHash,
        approved_plan_commit: "abc123",
        plan_pull_request: {
          number: 99,
          url: "https://github.com/test/repo/pull/99",
          branch: `opencode/workflow/${workflowID}-plan`,
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
    )

    await runApproval(
      WorkflowApproval.Service.use((svc) =>
        svc.createAmendment(tmp.path, workflowID, "Scope drift: touched config/keys.ts"),
      ),
    )

    const stateAfterCreate = await WorkflowArtifact.readState(tmp.path, workflowID)
    expect(stateAfterCreate.state).toBe("needs_amendment")

    const amendmentExists = await Bun.file(
      path.join(workflowDir, "AMENDMENT.md"),
    ).exists()
    expect(amendmentExists).toBe(true)

    const decisions = await Bun.file(
      path.join(workflowDir, "DECISIONS.md"),
    ).text()
    expect(decisions).toContain("workflow.amendment.created")

    await runApproval(
      WorkflowApproval.Service.use((svc) => svc.approveAmendment(tmp.path, workflowID)),
    )

    const stateAfterApprove = await WorkflowArtifact.readState(tmp.path, workflowID)
    expect(stateAfterApprove.state).toBe("executing")

    const decisions2 = await Bun.file(
      path.join(workflowDir, "DECISIONS.md"),
    ).text()
    expect(decisions2).toContain("workflow.amendment.approved")
  })

  test("rejects amendment and transitions to paused", async () => {
    await using tmp = await tmpdir({ git: true })
    const workflowID = "wf_reject"
    const approvedHash = await setupWorkflow(tmp.path, workflowID)

    const workflowDir = path.join(tmp.path, ".opencode", "workflows", workflowID)
    await Bun.write(
      path.join(workflowDir, "STATE.json"),
      JSON.stringify({
        workflow_id: workflowID,
        title: "Test Workflow",
        state: "needs_amendment",
        artifact_dir: `.opencode/workflows/${workflowID}`,
        created_at: WorkflowState.now(),
        updated_at: WorkflowState.now(),
        plan_branch: `opencode/workflow/${workflowID}-plan`,
        code_branch: `opencode/workflow/${workflowID}-code`,
        approved_spec_hash: approvedHash,
        approved_plan_commit: "abc123",
        plan_pull_request: {
          number: 99,
          url: "https://github.com/test/repo/pull/99",
          branch: `opencode/workflow/${workflowID}-plan`,
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
    )

    await Bun.write(
      path.join(workflowDir, "AMENDMENT.md"),
      `# Amendment

## Reason

Scope drift: touched config/keys.ts

## Scope Change

Expand allowed paths

## Affected Files

- config/keys.ts

## Approval Status

pending

## Created

2025-01-01T00:00:00.000Z
`,
    )

    await runApproval(
      WorkflowApproval.Service.use((svc) => svc.rejectAmendment(tmp.path, workflowID)),
    )

    const state = await WorkflowArtifact.readState(tmp.path, workflowID)
    expect(state.state).toBe("paused")

    const decisions = await Bun.file(
      path.join(workflowDir, "DECISIONS.md"),
    ).text()
    expect(decisions).toContain("workflow.amendment.rejected")
  })

  test("records plan approval evidence in decisions", async () => {
    await using tmp = await tmpdir({ git: true })
    const workflowID = "wf_evidence"
    await setupWorkflow(tmp.path, workflowID)

    const workflowDir = path.join(tmp.path, ".opencode", "workflows", workflowID)
    await Bun.write(
      path.join(workflowDir, "STATE.json"),
      JSON.stringify({
        workflow_id: workflowID,
        title: "Test Workflow",
        state: "awaiting_plan_review",
        artifact_dir: `.opencode/workflows/${workflowID}`,
        created_at: WorkflowState.now(),
        updated_at: WorkflowState.now(),
        plan_branch: `opencode/workflow/${workflowID}-plan`,
        code_branch: `opencode/workflow/${workflowID}-code`,
        plan_pull_request: {
          number: 99,
          url: "https://github.com/test/repo/pull/99",
          branch: `opencode/workflow/${workflowID}-plan`,
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
    )

    const evidence: PlanApprovalEvidence = {
      approved_spec_hash: "hash123",
      approved_plan_commit: "abc123",
      pull_request_number: 99,
      pull_request_url: "https://github.com/test/repo/pull/99",
      approved_by: "reviewer",
      approved_at: WorkflowState.now(),
    }

    await runApproval(
      WorkflowApproval.Service.use((svc) => svc.recordPlanApproval(tmp.path, workflowID, evidence)),
    )

    const state = await WorkflowArtifact.readState(tmp.path, workflowID)
    expect(state.approved_spec_hash).toBe("hash123")
    expect(state.approved_plan_commit).toBe("abc123")

    const decisions = await Bun.file(
      path.join(workflowDir, "DECISIONS.md"),
    ).text()
    expect(decisions).toContain("workflow.plan_approval.recorded")
  })
})
