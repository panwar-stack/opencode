import { Context, Effect, Layer, Option, Schema } from "effect"
import { Bus } from "@/bus"
import { WorkflowArtifact } from "./artifact"
import { WorkflowState, type WorkflowStateFile } from "./state"
import { WorkflowEvents } from "./events"
import { Config } from "@/config/config"

export type PlanApprovalEvidence = {
  readonly workflow_id?: string
  readonly approved_spec_hash: string
  readonly approved_plan_commit: string
  readonly pull_request_number: number
  readonly pull_request_url?: string
  readonly approved_by?: string
  readonly approved_at: string
  readonly approved_scope_summary?: string
  readonly github_review_evidence?: string
  readonly approval_source?: string
}

export type CodeApprovalEvidence = {
  readonly workflow_id?: string
  readonly pull_request_number: number
  readonly pull_request_url?: string
  readonly approved_plan_pull_request_number?: number
  readonly approved_spec_hash?: string
  readonly code_head_commit?: string
  readonly validation_evidence?: string
  readonly approved_by?: string
  readonly approved_at: string
  readonly github_review_evidence?: string
  readonly approval_source?: string
}

export type ApprovalStatus =
  | { readonly tag: "approved"; readonly evidence: PlanApprovalEvidence | CodeApprovalEvidence }
  | { readonly tag: "pending" }
  | { readonly tag: "rejected" }
  | { readonly tag: "needs_amendment"; readonly amendment_id?: string }

export const AmendmentState = Schema.Literals(["pending", "approved", "rejected"])

export type AmendmentStateType = Schema.Schema.Type<typeof AmendmentState>

export type AmendmentInfo = {
  readonly reason: string
  readonly scope_change: string
  readonly affected_files: readonly string[]
  readonly github_comment_id?: number
  readonly state: AmendmentStateType
  readonly created_at: string
  readonly resolved_at?: string
}

function parseAmendment(amendmentMd: string): AmendmentInfo {
  const lines = amendmentMd.split(/\r?\n/)
  const getSection = (header: string) => {
    const start = lines.findIndex((line) => new RegExp(`^##\\s+${header}\\s*$`, "i").test(line.trim()))
    if (start === -1) return ""
    return lines
      .slice(start + 1)
      .filter((line, index, rest) => rest.slice(0, index).every((previous) => !/^##\s+/.test(previous.trim())))
      .join("\n")
      .trim()
  }

  const files = getSection("Affected Files")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((line): line is string => line !== undefined && line.length > 0)

  const stateStr = getSection("Approval Status").toLowerCase()
  const state: AmendmentStateType = stateStr.includes("approved")
    ? "approved"
    : stateStr.includes("rejected")
      ? "rejected"
      : "pending"

  const githubMatch = getSection("GitHub Comment").match(/#?(\d+)/)

  return {
    reason: getSection("Reason"),
    scope_change: getSection("Scope Change"),
    affected_files: files,
    github_comment_id: githubMatch ? parseInt(githubMatch[1]) : undefined,
    state,
    created_at: getSection("Created") || WorkflowState.now(),
    resolved_at: getSection("Resolved") || undefined,
  }
}

function formatAmendment(info: AmendmentInfo): string {
  return [
    "# Amendment",
    "",
    "## Reason",
    "",
    info.reason,
    "",
    "## Scope Change",
    "",
    info.scope_change,
    "",
    "## Affected Files",
    "",
    ...info.affected_files.map((file) => `- ${file}`),
    info.github_comment_id ? "" : undefined,
    info.github_comment_id ? "## GitHub Comment" : undefined,
    info.github_comment_id ? "" : undefined,
    info.github_comment_id ? `- #${info.github_comment_id}` : undefined,
    "",
    "## Approval Status",
    "",
    info.state,
    "",
    "## Created",
    "",
    info.created_at,
    info.resolved_at ? "" : undefined,
    info.resolved_at ? "## Resolved" : undefined,
    info.resolved_at ? "" : undefined,
    info.resolved_at ? info.resolved_at : undefined,
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

function loadState(projectDir: string, workflowID: string): Effect.Effect<WorkflowStateFile> {
  return Effect.promise(() => WorkflowArtifact.readState(projectDir, workflowID))
}

function saveState(projectDir: string, state: WorkflowStateFile): Effect.Effect<void> {
  return Effect.promise(() => WorkflowArtifact.writeState(projectDir, state))
}

export interface Interface {
  recordPlanApproval: (projectDir: string, workflowID: string, evidence: PlanApprovalEvidence) => Effect.Effect<void>
  checkPlanApproval: (projectDir: string, workflowID: string) => Effect.Effect<ApprovalStatus>
  recordCodeApproval: (projectDir: string, workflowID: string, evidence: CodeApprovalEvidence) => Effect.Effect<void>
  checkCodeApproval: (projectDir: string, workflowID: string) => Effect.Effect<ApprovalStatus>
  createAmendment: (projectDir: string, workflowID: string, reason: string, githubCommentId?: number) => Effect.Effect<void>
  approveAmendment: (projectDir: string, workflowID: string) => Effect.Effect<void>
  rejectAmendment: (projectDir: string, workflowID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowApproval") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const busOpt = yield* Effect.serviceOption(Bus.Service)
    const configOpt = yield* Effect.serviceOption(Config.Service)
    const approvalSource = Option.isSome(configOpt)
      ? (yield* configOpt.value.get()).workflow?.github?.approval_source ?? "github_pr_review"
      : "github_pr_review"

    const publishSafe = (def: typeof WorkflowEvents.WorkflowUpdated, properties: { workflow_id: string; previous_state?: string; new_state: string; action?: string }) =>
      Option.isSome(busOpt)
        ? busOpt.value.publish(def, properties).pipe(Effect.catch(() => Effect.void))
        : Effect.void

    const recordPlanApproval = Effect.fn("WorkflowApproval.recordPlanApproval")(
      function* (projectDir: string, workflowID: string, evidence: PlanApprovalEvidence) {
        const state = yield* loadState(projectDir, workflowID)
        const source = evidence.approval_source ?? approvalSource
        const next = {
          ...WorkflowState.transitionOrCurrent(state, "plan_approved"),
          approved_spec_hash: evidence.approved_spec_hash,
          approved_plan_commit: evidence.approved_plan_commit,
          plan_approval: {
            workflow_id: workflowID,
            pull_request_number: evidence.pull_request_number,
            pull_request_url: evidence.pull_request_url,
            spec_version: state.spec_version ?? 1,
            approved_spec_hash: evidence.approved_spec_hash,
            approved_plan_commit: evidence.approved_plan_commit,
            approved_scope_summary: evidence.approved_scope_summary,
            approved_by: evidence.approved_by,
            approved_at: evidence.approved_at,
            github_review_evidence: evidence.github_review_evidence,
            approval_source: source,
          },
          updated_at: WorkflowState.now(),
        }
        yield* saveState(projectDir, next)
        yield* Effect.promise(() =>
          WorkflowArtifact.appendDecision(projectDir, workflowID, {
            action: "workflow.plan_approval.recorded",
            previous_state: state.state,
            new_state: next.state,
            summary: `Plan approved by ${evidence.approved_by ?? "reviewer"} on PR #${evidence.pull_request_number} (source: ${source}).`,
            evidence: evidence.approved_spec_hash,
            pull_request: evidence.pull_request_number,
          }),
        )
      },
    )

    const checkPlanApproval = Effect.fn("WorkflowApproval.checkPlanApproval")(
      function* (projectDir: string, workflowID: string) {
        const state = yield* loadState(projectDir, workflowID)
        const plan = state.plan_pull_request
        if (
          WorkflowState.isApprovedReview(plan.review_state) &&
          plan.number &&
          plan.head_commit &&
          state.approved_spec_hash &&
          state.approved_plan_commit === plan.head_commit
        ) {
          return {
            tag: "approved" as const,
            evidence: {
              workflow_id: workflowID,
              approved_spec_hash: state.approved_spec_hash,
              approved_plan_commit: state.approved_plan_commit,
              pull_request_number: plan.number,
              pull_request_url: plan.url,
              approved_at: WorkflowState.now(),
              github_review_evidence: plan.url,
            },
          } satisfies ApprovalStatus
        }
        if (plan.review_state === "changes_requested") {
          return { tag: "rejected" as const } satisfies ApprovalStatus
        }
        return { tag: "pending" as const } satisfies ApprovalStatus
      },
    )

    const recordCodeApproval = Effect.fn("WorkflowApproval.recordCodeApproval")(
      function* (projectDir: string, workflowID: string, evidence: CodeApprovalEvidence) {
        const state = yield* loadState(projectDir, workflowID)
        const source = evidence.approval_source ?? approvalSource
        const next = {
          ...state,
          code_approval: {
            workflow_id: workflowID,
            pull_request_number: evidence.pull_request_number,
            pull_request_url: evidence.pull_request_url,
            approved_plan_pull_request_number: evidence.approved_plan_pull_request_number,
            approved_spec_hash: evidence.approved_spec_hash,
            code_head_commit: evidence.code_head_commit,
            validation_evidence: evidence.validation_evidence,
            approved_by: evidence.approved_by,
            approved_at: evidence.approved_at,
            github_review_evidence: evidence.github_review_evidence,
            approval_source: source,
          },
          updated_at: WorkflowState.now(),
        }
        yield* saveState(projectDir, next)
        yield* Effect.promise(() =>
          WorkflowArtifact.appendDecision(projectDir, workflowID, {
            action: "workflow.code_approval.recorded",
            previous_state: state.state,
            new_state: next.state,
            summary: `Code approved by ${evidence.approved_by ?? "reviewer"} on PR #${evidence.pull_request_number} (source: ${source}).`,
            pull_request: evidence.pull_request_number,
          }),
        )
      },
    )

    const checkCodeApproval = Effect.fn("WorkflowApproval.checkCodeApproval")(
      function* (projectDir: string, workflowID: string) {
        const state = yield* loadState(projectDir, workflowID)
        const code = state.code_pull_request
        if (
          WorkflowState.isApprovedReview(code.review_state) &&
          code.number &&
          code.head_commit &&
          state.plan_pull_request.number &&
          state.approved_spec_hash &&
          state.approved_plan_commit &&
          state.last_validation?.ok
        ) {
          return {
            tag: "approved" as const,
            evidence: {
              workflow_id: workflowID,
              pull_request_number: code.number,
              pull_request_url: code.url,
              approved_plan_pull_request_number: state.plan_pull_request.number,
              approved_spec_hash: state.approved_spec_hash,
              code_head_commit: code.head_commit,
              validation_evidence: state.last_validation.summary,
              approved_at: WorkflowState.now(),
              github_review_evidence: code.url,
            },
          } satisfies ApprovalStatus
        }
        if (code.review_state === "changes_requested") {
          return { tag: "rejected" as const } satisfies ApprovalStatus
        }
        return { tag: "pending" as const } satisfies ApprovalStatus
      },
    )

    const createAmendment = Effect.fn("WorkflowApproval.createAmendment")(
      function* (projectDir: string, workflowID: string, reason: string, githubCommentId?: number) {
        const state = yield* loadState(projectDir, workflowID)
        const scopeChange = reason.includes("forbidden") ? "Add forbidden path exception" : "Expand allowed paths"
        const info: AmendmentInfo = {
          reason,
          scope_change: scopeChange,
          affected_files: [],
          github_comment_id: githubCommentId,
          state: "pending",
          created_at: WorkflowState.now(),
        }
        yield* Effect.promise(() =>
          WorkflowArtifact.writeArtifact(projectDir, workflowID, "AMENDMENT.md", formatAmendment(info)),
        )
        const next = WorkflowState.withState(state, "needs_amendment")
        yield* saveState(projectDir, next)
        yield* Effect.promise(() =>
          WorkflowArtifact.appendDecision(projectDir, workflowID, {
            action: "workflow.amendment.created",
            previous_state: state.state,
            new_state: next.state,
            summary: `Amendment created: ${reason}`,
            github_comment_url: githubCommentId
              ? `https://github.com/comment/${githubCommentId}`
              : undefined,
          }),
        )
      },
    )

    const approveAmendment = Effect.fn("WorkflowApproval.approveAmendment")(
      function* (projectDir: string, workflowID: string) {
        const state = yield* loadState(projectDir, workflowID)
        const amendmentText = yield* Effect.promise(() =>
          WorkflowArtifact.readArtifact(projectDir, workflowID, "AMENDMENT.md"),
        ).pipe(Effect.catch(() => Effect.succeed("")))

        const parsed = parseAmendment(amendmentText)
        const info: AmendmentInfo = {
          ...parsed,
          state: "approved",
          resolved_at: WorkflowState.now(),
        }
        yield* Effect.promise(() =>
          WorkflowArtifact.writeArtifact(projectDir, workflowID, "AMENDMENT.md", formatAmendment(info)),
        )

        const impact = yield* Effect.promise(() =>
          WorkflowArtifact.readArtifact(projectDir, workflowID, "IMPACT.md"),
        ).pipe(Effect.catch(() => Effect.succeed("")))

        if (parsed.affected_files.length > 0) {
          const newPaths = parsed.affected_files.map((f) => `- ${f}`).join("\n")
          const updatedImpact = /^##\s+Allowed Paths\s*$/im.test(impact)
            ? impact.replace(/(^##\s+Allowed Paths\s*\r?\n)/im, `$1\n${newPaths}\n`)
            : `${impact.trimEnd()}\n\n## Allowed Paths\n\n${newPaths}\n`
          yield* Effect.promise(() =>
            WorkflowArtifact.writeArtifact(projectDir, workflowID, "IMPACT.md", updatedImpact),
          )
        }

        const newHash = yield* Effect.promise(() =>
          WorkflowArtifact.hashApprovedArtifacts(projectDir, workflowID),
        )

        const next = {
          ...WorkflowState.withState(state, "executing"),
          approved_spec_hash: newHash,
          user_input_needed: undefined,
          updated_at: WorkflowState.now(),
        }
        yield* saveState(projectDir, next)
        yield* Effect.promise(() =>
          WorkflowArtifact.appendDecision(projectDir, workflowID, {
            action: "workflow.amendment.approved",
            previous_state: state.state,
            new_state: next.state,
            summary: `Amendment approved (source: ${approvalSource}). Reason: ${parsed.reason}. Scope expanded: ${info.scope_change}. Affected files: ${parsed.affected_files.join(", ") || "none"}.`,
            evidence: newHash,
          }),
        )
        yield* publishSafe(WorkflowEvents.WorkflowUpdated, {
          workflow_id: workflowID,
          previous_state: state.state,
          new_state: next.state,
          action: "amendment_approved",
        })
      },
    )

    const rejectAmendment = Effect.fn("WorkflowApproval.rejectAmendment")(
      function* (projectDir: string, workflowID: string) {
        const state = yield* loadState(projectDir, workflowID)
        const amendmentText = yield* Effect.promise(() =>
          WorkflowArtifact.readArtifact(projectDir, workflowID, "AMENDMENT.md"),
        ).pipe(Effect.catch(() => Effect.succeed("")))

        const parsed = parseAmendment(amendmentText)
        const info: AmendmentInfo = {
          ...parsed,
          state: "rejected",
          resolved_at: WorkflowState.now(),
        }
        const recoveryNote =
          "\n## Recovery Instructions\n\n" +
          "This amendment was rejected. The original approved scope remains in effect.\n\n" +
          "To proceed:\n" +
          "1. Revise the amendment and re-submit for approval, or\n" +
          "2. Address the reviewer's feedback and continue within the current scope, or\n" +
          "3. Request a scope review from the plan reviewer.\n"
        yield* Effect.promise(() =>
          WorkflowArtifact.writeArtifact(projectDir, workflowID, "AMENDMENT.md", formatAmendment(info) + recoveryNote),
        )
        const next = {
          ...WorkflowState.withState(state, "paused"),
          user_input_needed:
            "Amendment was rejected. Review AMENDMENT.md for the rejection reason and recovery instructions. You can create a new amendment with revised scope, or continue within the current approved scope.",
          updated_at: WorkflowState.now(),
        }
        yield* saveState(projectDir, next)
        yield* Effect.promise(() =>
          WorkflowArtifact.appendDecision(projectDir, workflowID, {
            action: "workflow.amendment.rejected",
            previous_state: state.state,
            new_state: next.state,
            summary: `Amendment rejected. Reason: ${parsed.reason}. Workflow paused for revision. See AMENDMENT.md for recovery instructions.`,
          }),
        )
        yield* publishSafe(WorkflowEvents.WorkflowUpdated, {
          workflow_id: workflowID,
          previous_state: state.state,
          new_state: next.state,
          action: "amendment_rejected",
        })
      },
    )

    return Service.of({
      recordPlanApproval,
      checkPlanApproval,
      recordCodeApproval,
      checkCodeApproval,
      createAmendment,
      approveAmendment,
      rejectAmendment,
    })
  }),
)

export const defaultLayer = layer

export * as WorkflowApproval from "./approval"
