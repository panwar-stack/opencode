import { randomBytes } from "crypto"

export const WorkflowStates = [
  "created",
  "drafting_spec",
  "submitting_plan_pull_request",
  "awaiting_plan_review",
  "addressing_plan_comments",
  "plan_approved",
  "executing",
  "validating",
  "submitting_code_pull_request",
  "awaiting_code_review",
  "addressing_code_comments",
  "needs_amendment",
  "paused",
  "failed",
  "cancelled",
  "completed",
] as const

export type StateName = (typeof WorkflowStates)[number]

export const ReviewStates = ["none", "pending", "commented", "changes_requested", "approved", "merged"] as const

export type ReviewState = (typeof ReviewStates)[number]

export const SessionRoles = ["planner", "plan_reviewer", "executor", "validator", "code_reviewer", "amendment", "recovery"] as const

export type SessionRole = (typeof SessionRoles)[number]

export type WorkflowSession = {
  readonly id: string
  readonly role: SessionRole
  readonly status: "active" | "waiting" | "completed" | "failed"
  readonly task: string
  readonly agent?: string
  readonly files_touched?: readonly string[]
  readonly input_needed?: string
  readonly created_at: string
  readonly updated_at: string
  readonly github_comment_url?: string
}

export type ReviewComment = {
  readonly id: string
  readonly url?: string
  readonly author?: string
  readonly body: string
  readonly state: CommentState
  readonly source: "issue_comment" | "review_comment" | "review"
  readonly path?: string
  readonly line?: number
  readonly created_at?: string
  readonly updated_at?: string
}

export const CommentStates = ["open", "addressed", "out_of_scope", "superseded", "blocked"] as const

export type CommentState = (typeof CommentStates)[number]

export type PullRequestState = {
  readonly number?: number
  readonly url?: string
  readonly branch?: string
  readonly head_commit?: string
  readonly review_state: ReviewState
  readonly reviewers?: readonly string[]
  readonly latest_review_at?: string
  readonly latest_review_url?: string
  readonly approved_by?: string
  readonly approved_at?: string
  readonly comments: readonly ReviewComment[]
}

export type PullRequestKind = "plan" | "code"

export type PlanApprovalRecord = {
  readonly workflow_id: string
  readonly pull_request_number: number
  readonly pull_request_url?: string
  readonly spec_version?: number
  readonly approved_spec_hash: string
  readonly approved_plan_commit: string
  readonly approved_scope_summary?: string
  readonly approved_by?: string
  readonly approved_at: string
  readonly github_review_evidence?: string
}

export type CodeApprovalRecord = {
  readonly workflow_id: string
  readonly pull_request_number: number
  readonly pull_request_url?: string
  readonly approved_plan_pull_request_number?: number
  readonly approved_spec_hash?: string
  readonly code_head_commit?: string
  readonly validation_evidence?: string
  readonly approved_by?: string
  readonly approved_at: string
  readonly github_review_evidence?: string
}

export type WorkflowStateFile = {
  readonly workflow_id: string
  readonly title: string
  readonly state: StateName
  readonly artifact_dir: string
  readonly created_at: string
  readonly updated_at: string
  readonly spec_version?: number
  readonly plan_branch: string
  readonly code_branch?: string
  readonly approved_spec_hash?: string
  readonly approved_plan_commit?: string
  readonly plan_approval?: PlanApprovalRecord
  readonly code_approval?: CodeApprovalRecord
  readonly paused_from_state?: StateName
  readonly completed_tasks?: readonly string[]
  readonly current_task?: string
  readonly active_session_id?: string
  readonly user_input_needed?: string
  readonly last_synced_at?: string
  readonly last_validation?: {
    readonly ok: boolean
    readonly summary: string
    readonly checked_at: string
    readonly files?: readonly string[]
    readonly allowed_paths?: readonly string[]
  }
  readonly plan_pull_request: PullRequestState
  readonly code_pull_request: PullRequestState
  readonly sessions: readonly WorkflowSession[]
}

const activeStates = new Set<StateName>([
  "created",
  "drafting_spec",
  "submitting_plan_pull_request",
  "awaiting_plan_review",
  "addressing_plan_comments",
  "plan_approved",
  "executing",
  "validating",
  "submitting_code_pull_request",
  "awaiting_code_review",
  "addressing_code_comments",
  "needs_amendment",
])

const transitions: Record<StateName, readonly StateName[]> = {
  created: ["drafting_spec", "paused", "failed", "cancelled"],
  drafting_spec: ["submitting_plan_pull_request", "awaiting_plan_review", "paused", "failed", "cancelled"],
  submitting_plan_pull_request: ["awaiting_plan_review", "addressing_plan_comments", "paused", "failed", "cancelled"],
  awaiting_plan_review: ["addressing_plan_comments", "plan_approved", "paused", "failed", "cancelled"],
  addressing_plan_comments: ["awaiting_plan_review", "plan_approved", "paused", "failed", "cancelled"],
  plan_approved: ["addressing_plan_comments", "executing", "needs_amendment", "paused", "failed", "cancelled"],
  executing: ["validating", "submitting_code_pull_request", "awaiting_code_review", "needs_amendment", "paused", "failed", "cancelled"],
  validating: ["executing", "submitting_code_pull_request", "awaiting_code_review", "needs_amendment", "paused", "failed", "cancelled"],
  submitting_code_pull_request: ["awaiting_code_review", "addressing_code_comments", "needs_amendment", "paused", "failed", "cancelled"],
  awaiting_code_review: ["addressing_code_comments", "completed", "needs_amendment", "paused", "failed", "cancelled"],
  addressing_code_comments: ["validating", "awaiting_code_review", "completed", "needs_amendment", "paused", "failed", "cancelled"],
  needs_amendment: ["executing", "paused", "failed", "cancelled"],
  paused: [
    "created",
    "drafting_spec",
    "submitting_plan_pull_request",
    "awaiting_plan_review",
    "addressing_plan_comments",
    "plan_approved",
    "executing",
    "validating",
    "submitting_code_pull_request",
    "awaiting_code_review",
    "addressing_code_comments",
    "needs_amendment",
    "failed",
    "cancelled",
  ],
  failed: [],
  cancelled: [],
  completed: [],
}

export function createWorkflowID() {
  return `wf_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`
}

export function createSessionID() {
  return `ses_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`
}

export function now() {
  return new Date().toISOString()
}

export function emptyPullRequest(): PullRequestState {
  return {
    review_state: "none",
    comments: [],
  }
}

export function isApprovedReview(state: ReviewState) {
  return state === "approved" || state === "merged"
}

export function canTransition(from: StateName, to: StateName) {
  if (from === to) return true
  if (activeStates.has(from) && to === "paused") return true
  return transitions[from].includes(to)
}

export function transitionOrCurrent(file: WorkflowStateFile, state: StateName): WorkflowStateFile {
  if (!canTransition(file.state, state)) return file
  return withState(file, state)
}

export function assertTransition(from: StateName, to: StateName) {
  if (canTransition(from, to)) return
  throw new Error(`Invalid workflow transition from ${from} to ${to}`)
}

export function withState(file: WorkflowStateFile, state: StateName): WorkflowStateFile {
  assertTransition(file.state, state)
  return {
    ...file,
    state,
    updated_at: now(),
  }
}

export function openComments(file: WorkflowStateFile) {
  return [...file.plan_pull_request.comments, ...file.code_pull_request.comments].filter(
    (comment) => comment.state === "open",
  )
}

export function commentsForPullRequest(file: WorkflowStateFile, pullRequest: PullRequestKind) {
  return (pullRequest === "plan" ? file.plan_pull_request : file.code_pull_request).comments
}

export function upsertSession(file: WorkflowStateFile, session: WorkflowSession): WorkflowStateFile {
  const exists = file.sessions.some((item) => item.id === session.id)
  return {
    ...file,
    active_session_id: session.status === "active" ? session.id : file.active_session_id,
    sessions: exists
      ? file.sessions.map((item) => (item.id === session.id ? session : item))
      : [...file.sessions, session],
    updated_at: now(),
  }
}

export function updateSession(
  file: WorkflowStateFile,
  sessionID: string,
  update: Partial<Omit<WorkflowSession, "id" | "created_at">>,
): WorkflowStateFile {
  const session = file.sessions.find((item) => item.id === sessionID)
  if (!session) throw new Error(`Workflow session not found: ${sessionID}`)
  const next = {
    ...session,
    ...update,
    updated_at: now(),
  }
  return upsertSession(file, next)
}

export function setActiveSession(file: WorkflowStateFile, sessionID: string): WorkflowStateFile {
  if (!file.sessions.some((session) => session.id === sessionID)) {
    throw new Error(`Workflow session not found: ${sessionID}`)
  }
  return {
    ...file,
    active_session_id: sessionID,
    updated_at: now(),
  }
}

export function markComment(
  file: WorkflowStateFile,
  pullRequest: PullRequestKind,
  commentID: string,
  state: CommentState,
): WorkflowStateFile {
  const key = pullRequest === "plan" ? "plan_pull_request" : "code_pull_request"
  const found = file[key].comments.some((comment) => comment.id === commentID)
  if (!found) throw new Error(`Workflow ${pullRequest} comment not found: ${commentID}`)
  return {
    ...file,
    [key]: {
      ...file[key],
      comments: file[key].comments.map((comment) =>
        comment.id === commentID
          ? {
              ...comment,
              state,
              updated_at: now(),
            }
          : comment,
      ),
    },
    updated_at: now(),
  }
}

export function appendComment(
  file: WorkflowStateFile,
  pullRequest: PullRequestKind,
  comment: Omit<ReviewComment, "state" | "source"> &
    Partial<Pick<ReviewComment, "state" | "source" | "created_at" | "updated_at">>,
): WorkflowStateFile {
  const key = pullRequest === "plan" ? "plan_pull_request" : "code_pull_request"
  const next = {
    id: comment.id,
    url: comment.url,
    author: comment.author,
    body: comment.body,
    state: comment.state ?? "open",
    source: comment.source ?? "issue_comment",
    path: comment.path,
    line: comment.line,
    created_at: comment.created_at ?? now(),
    updated_at: comment.updated_at ?? now(),
  }
  return {
    ...file,
    [key]: {
      ...file[key],
      comments: [...file[key].comments.filter((item) => item.id !== next.id), next],
    },
    updated_at: now(),
  }
}

export * as WorkflowState from "./state"
