import path from "path"
import { Context, Effect, Layer, Stream } from "effect"
import { Bus } from "@/bus"
import { WorkflowArtifact, type ValidationResult } from "./artifact"
import { WorkflowGithub } from "./github"
import { WorkflowApproval } from "./approval"
import { WorkflowScope } from "./scope"
import {
  WorkflowState,
  type CommentState,
  type PullRequestKind,
  type ReviewComment,
  type WorkflowSession,
  type WorkflowStateFile,
} from "./state"
import { WorkflowEvents } from "./events"

type CommandResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

type GhPullRequestView = {
  readonly number?: number
  readonly url?: string
  readonly headRefName?: string
  readonly headRefOid?: string
  readonly reviewDecision?: string | null
  readonly state?: string
}

type StartInput = {
  readonly directory: string
  readonly title: string
  readonly localDraft?: boolean
}

type SubmitInput = {
  readonly directory: string
  readonly workflowID: string
  readonly base?: string
  readonly dryRun?: boolean
  readonly repo?: string
}

type RunInput = {
  readonly directory: string
  readonly workflowID: string
  readonly dryRun?: boolean
}

type SyncInput = {
  readonly directory: string
  readonly workflowID: string
  readonly repo?: string
}

type CommitInput = {
  readonly directory: string
  readonly workflowID: string
  readonly message?: string
}

type RevisePlanInput = {
  readonly directory: string
  readonly workflowID: string
  readonly instruction?: string
  readonly githubCommentUrl?: string
}

type SteerInput = {
  readonly directory: string
  readonly workflowID: string
  readonly sessionID: string
  readonly instruction: string
  readonly githubCommentUrl?: string
}

type MarkCommentInput = {
  readonly directory: string
  readonly workflowID: string
  readonly pullRequest: PullRequestKind
  readonly commentID: string
  readonly state: CommentState
  readonly summary?: string
}

type RecordCommentInput = {
  readonly directory: string
  readonly workflowID: string
  readonly pullRequest: PullRequestKind
  readonly comment: Omit<ReviewComment, "state" | "source"> &
    Partial<Pick<ReviewComment, "state" | "source" | "created_at" | "updated_at">>
}

type AmendmentInput = {
  readonly directory: string
  readonly workflowID: string
  readonly approve: boolean
  readonly reason?: string
}

const execCommand = (command: string, args: readonly string[], cwd: string) =>
  Effect.gen(function* () {
    const proc = Bun.spawn([command, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Effect.promise(() => new Response(proc.stdout).text()),
        Effect.promise(() => new Response(proc.stderr).text()),
        Effect.promise(() => proc.exited),
      ],
      { concurrency: 3 },
    )
    return {
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    }
  })

const runRequired = (command: string, args: readonly string[], cwd: string) =>
  Effect.gen(function* () {
    const result = yield* execCommand(command, args, cwd)
    if (result.exitCode === 0) return result.stdout
    return yield* Effect.fail(new Error(result.stderr || `${command} ${args.join(" ")} failed`))
  })

const slug = (input: string) =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "workflow"

const planBranch = (workflowID: string, title: string) =>
  `opencode/workflow/${workflowID}-${slug(title)}-plan`

const codeBranch = (workflowID: string, title: string) =>
  `opencode/workflow/${workflowID}-${slug(title)}-code`

const currentBranch = (directory: string) => runRequired("git", ["branch", "--show-current"], directory)

const headCommit = (directory: string) => runRequired("git", ["rev-parse", "HEAD"], directory)

const ghPullRequestStateForBranch = (directory: string, branch: string) =>
  Effect.gen(function* () {
    const output = yield* runRequired(
      "gh",
      ["pr", "view", branch, "--json", "number,url,headRefName,headRefOid,reviewDecision,state"],
      directory,
    )
    const parsed = JSON.parse(output) as GhPullRequestView
    return WorkflowGithub.pullRequestStateFromGh({
      number: parsed.number,
      url: parsed.url,
      headRefName: parsed.headRefName ?? branch,
      headRefOid: parsed.headRefOid,
      reviewDecision: parsed.reviewDecision,
      state: parsed.state,
      comments: [],
      reviews: [],
    })
  })

const changedFiles = (directory: string, base: string) =>
  Effect.gen(function* () {
    const mergeBase = yield* execCommand("git", ["merge-base", base, "HEAD"], directory)
    const tracked =
      mergeBase.exitCode === 0
        ? yield* runRequired("git", ["diff", "--name-only", `${mergeBase.stdout}..HEAD`], directory)
        : yield* runRequired("git", ["diff", "--name-only", base], directory)
    const status = yield* runRequired("git", ["status", "--porcelain=v1", "--untracked-files=all"], directory)
    return [...tracked.split(/\r?\n/), ...status.split(/\r?\n/).map((line) => line.slice(3))]
      .map((file) => file.trim())
      .filter(Boolean)
      .filter((file, index, list) => list.indexOf(file) === index)
  })

const checkoutBranch = (directory: string, branch: string) =>
  Effect.gen(function* () {
    const cur = yield* currentBranch(directory).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (cur === branch) return
    const verify = yield* execCommand("git", ["rev-parse", "--verify", branch], directory)
    if (verify.exitCode === 0) {
      yield* runRequired("git", ["checkout", branch], directory)
      return
    }
    yield* runRequired("git", ["checkout", "-b", branch], directory)
  })

const prBody = (state: WorkflowStateFile, specHash?: string) =>
  [
    `# Workflow plan: ${state.title}`,
    "",
    `Workflow: ${state.workflow_id}`,
    `State: ${state.state}`,
    specHash ? `Artifact hash: ${specHash}` : undefined,
    "",
    "Artifacts:",
    "",
    `- ${WorkflowArtifact.relativeArtifactDir(state.workflow_id)}/SPEC.md`,
    `- ${WorkflowArtifact.relativeArtifactDir(state.workflow_id)}/TASKS.md`,
    `- ${WorkflowArtifact.relativeArtifactDir(state.workflow_id)}/IMPACT.md`,
    `- ${WorkflowArtifact.relativeArtifactDir(state.workflow_id)}/GITHUB.md`,
    "",
    "This pull request is the plan approval surface. Implementation should not begin until this PR is approved.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")

const codePrBody = (state: WorkflowStateFile) =>
  [
    `# Workflow implementation: ${state.title}`,
    "",
    `Workflow: ${state.workflow_id}`,
    `State: ${state.state}`,
    state.approved_spec_hash ? `Approved artifact hash: ${state.approved_spec_hash}` : undefined,
    state.approved_plan_commit ? `Approved plan commit: ${state.approved_plan_commit}` : undefined,
    "",
    "Approved artifacts:",
    "",
    `- ${WorkflowArtifact.relativeArtifactDir(state.workflow_id)}/SPEC.md`,
    `- ${WorkflowArtifact.relativeArtifactDir(state.workflow_id)}/TASKS.md`,
    `- ${WorkflowArtifact.relativeArtifactDir(state.workflow_id)}/IMPACT.md`,
    "",
    "This pull request is the implementation review surface for the approved workflow plan.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")

const persist = (artifact: WorkflowArtifact.Interface, directory: string, state: WorkflowStateFile) =>
  Effect.all(
    [artifact.writeState(directory, state), artifact.writeGithubSummary(directory, state)],
    { concurrency: 2 },
  )

const assertApprovedPlan = (artifact: WorkflowArtifact.Interface, directory: string, state: WorkflowStateFile) =>
  Effect.gen(function* () {
    if (!state.plan_pull_request.number) {
      return yield* Effect.fail(new Error("Workflow plan approval is missing plan pull request metadata."))
    }
    if (!WorkflowState.isApprovedReview(state.plan_pull_request.review_state)) {
      return yield* Effect.fail(new Error("Workflow plan pull request must be approved before execution."))
    }
    if (!state.approved_spec_hash)
      return yield* Effect.fail(new Error("Workflow plan approval is missing an approved artifact hash."))
    if (!state.approved_plan_commit || !state.plan_pull_request.head_commit) {
      return yield* Effect.fail(new Error("Workflow plan approval is missing approved head commit evidence."))
    }
    if (state.approved_plan_commit !== state.plan_pull_request.head_commit) {
      return yield* Effect.fail(new Error("Approved plan commit does not match the current plan pull request head."))
    }
    const hash = yield* artifact.hashApprovedArtifacts(directory, state.workflow_id)
    if (hash === state.approved_spec_hash) return hash
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
      state.state === "executing" ||
        state.state === "validating" ||
        state.state === "submitting_code_pull_request" ||
        state.state === "awaiting_code_review" ||
        state.state === "addressing_code_comments"
        ? "needs_amendment"
        : "addressing_plan_comments",
    )
    yield* persist(artifact, directory, next)
    yield* artifact.appendDecision(directory, state.workflow_id, {
      action: "workflow.approved_plan.invalidated",
      previous_state: state.state,
      new_state: next.state,
      summary: "Approved workflow artifacts changed after approval. Plan approval evidence was cleared.",
      evidence: state.approved_spec_hash,
      pull_request: state.plan_pull_request.number,
    })
    return yield* Effect.fail(
      new Error("Approved workflow artifacts changed after approval. Revise and re-approve the plan before execution."),
    )
  })

const openCommentCount = (comments: readonly ReviewComment[]) =>
  comments.filter((comment) => comment.state === "open").length

const withPlanReviewState = (state: WorkflowStateFile): WorkflowStateFile => {
  if (WorkflowState.isApprovedReview(state.plan_pull_request.review_state)) {
    return WorkflowState.transitionOrCurrent(state, "plan_approved")
  }
  if (
    state.plan_pull_request.review_state === "changes_requested" &&
    openCommentCount(state.plan_pull_request.comments) > 0
  ) {
    return WorkflowState.transitionOrCurrent(state, "addressing_plan_comments")
  }
  if (state.plan_pull_request.review_state === "pending" || state.plan_pull_request.review_state === "commented") {
    return WorkflowState.transitionOrCurrent(state, "awaiting_plan_review")
  }
  return state
}

const withCodeReviewState = (state: WorkflowStateFile): WorkflowStateFile => {
  if (!state.code_pull_request.number && state.code_pull_request.review_state === "none") return state
  const started = state.state === "plan_approved" ? WorkflowState.withState(state, "executing") : state
  if (WorkflowState.isApprovedReview(started.code_pull_request.review_state)) {
    if (started.last_validation?.ok) return WorkflowState.transitionOrCurrent(started, "completed")
    return {
      ...WorkflowState.transitionOrCurrent(started, "awaiting_code_review"),
      user_input_needed: "Code pull request is approved, but required validation evidence is missing.",
      updated_at: WorkflowState.now(),
    }
  }
  const review = WorkflowState.transitionOrCurrent(started, "awaiting_code_review")
  if (
    review.code_pull_request.review_state === "changes_requested" &&
    openCommentCount(review.code_pull_request.comments) > 0
  ) {
    return WorkflowState.transitionOrCurrent(review, "addressing_code_comments")
  }
  return review
}

const withCommentBookkeepingState = (state: WorkflowStateFile, pullRequest: PullRequestKind): WorkflowStateFile => {
  if (
    pullRequest === "plan" &&
    state.state === "addressing_plan_comments" &&
    openCommentCount(state.plan_pull_request.comments) === 0
  ) {
    return WorkflowState.transitionOrCurrent(state, "awaiting_plan_review")
  }
  if (
    pullRequest === "code" &&
    state.state === "addressing_code_comments" &&
    openCommentCount(state.code_pull_request.comments) === 0
  ) {
    return WorkflowState.transitionOrCurrent(state, "awaiting_code_review")
  }
  if (pullRequest === "plan") return withPlanReviewState(state)
  return withCodeReviewState(state)
}

const nextSession = (role: WorkflowSession["role"], task: string, githubCommentUrl?: string): WorkflowSession => {
  const created = WorkflowState.now()
  return {
    id: WorkflowState.createSessionID(),
    role,
    status: "active",
    task,
    created_at: created,
    updated_at: created,
    github_comment_url: githubCommentUrl,
  }
}

const withAmendmentStatus = (content: string, status: "approved" | "rejected", resolvedAt: string) => {
  const body = content.trim().length > 0 ? content.trim() : "# Amendment"
  const updated = /^##\s+Approval Status\s*$/im.test(body)
    ? body.replace(
        /(##\s+Approval Status\s*\r?\n)([\s\S]*?)(?=\r?\n##\s+|$)/i,
        `$1\n${status}\n`,
      )
    : `${body}\n\n## Approval Status\n\n${status}`
  if (/^##\s+Resolved\s*$/im.test(updated)) {
    return updated.replace(/(##\s+Resolved\s*\r?\n)([\s\S]*?)(?=\r?\n##\s+|$)/i, `$1\n${resolvedAt}\n`) + "\n"
  }
  return `${updated.trim()}\n\n## Resolved\n\n${resolvedAt}\n`
}

const postApprovalState = (state: WorkflowStateFile) =>
  state.approved_spec_hash !== undefined ||
  state.state === "plan_approved" ||
  state.state === "executing" ||
  state.state === "validating" ||
  state.state === "submitting_code_pull_request" ||
  state.state === "awaiting_code_review" ||
  state.state === "addressing_code_comments" ||
  state.state === "needs_amendment"

const amendmentState = (
  state: WorkflowStateFile,
  reason: string,
  comment?: ReviewComment,
): WorkflowStateFile => {
  const next = WorkflowState.transitionOrCurrent(
    {
      ...state,
      current_task: "Review workflow amendment",
      user_input_needed: reason,
      code_pull_request: comment
        ? {
            ...state.code_pull_request,
            comments: [
              ...state.code_pull_request.comments.filter((item) => item.id !== comment.id),
              {
                ...comment,
                state: "out_of_scope",
                updated_at: WorkflowState.now(),
              },
            ],
          }
        : state.code_pull_request,
    },
    "needs_amendment",
  )
  return WorkflowState.upsertSession(next, nextSession("amendment", reason, comment?.url))
}

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<WorkflowStateFile, Error>
  readonly get: (directory: string, workflowID: string) => Effect.Effect<WorkflowStateFile, Error>
  readonly all: (directory: string) => Effect.Effect<readonly WorkflowStateFile[], Error>
  readonly validatePlan: (directory: string, workflowID: string, base?: string) => Effect.Effect<ValidationResult, Error>
  readonly submitPlan: (input: SubmitInput) => Effect.Effect<WorkflowStateFile, Error>
  readonly validateCode: (directory: string, workflowID: string, base?: string) => Effect.Effect<ValidationResult, Error>
  readonly scopeDrift: (directory: string, workflowID: string, files: readonly string[]) => Effect.Effect<ValidationResult, Error>
  readonly revisePlan: (input: RevisePlanInput) => Effect.Effect<WorkflowStateFile, Error>
  readonly runApprovedPlan: (input: RunInput) => Effect.Effect<WorkflowStateFile, Error>
  readonly run: (input: RunInput) => Effect.Effect<WorkflowStateFile, Error>
  readonly submitCode: (input: SubmitInput) => Effect.Effect<WorkflowStateFile, Error>
  readonly syncGithub: (input: SyncInput) => Effect.Effect<WorkflowStateFile, Error>
  readonly pause: (directory: string, workflowID: string) => Effect.Effect<WorkflowStateFile, Error>
  readonly resume: (directory: string, workflowID: string) => Effect.Effect<WorkflowStateFile, Error>
  readonly findSession: (state: WorkflowStateFile, sessionID: string) => WorkflowSession | undefined
  readonly getSession: (directory: string, workflowID: string, sessionID: string) => Effect.Effect<WorkflowSession, Error>
  readonly sessionContext: (
    directory: string,
    workflowID: string,
    sessionID: string,
  ) => Effect.Effect<{
    workflow: WorkflowStateFile
    session: WorkflowSession
    artifacts: Record<string, string>
    open_comments: readonly ReviewComment[]
    allowed_paths: readonly string[]
  }, Error>
  readonly context: (
    directory: string,
    workflowID: string,
    sessionID: string,
  ) => Effect.Effect<{
    workflow: WorkflowStateFile
    session: WorkflowSession
    artifacts: Record<string, string>
    open_comments: readonly ReviewComment[]
    allowed_paths: readonly string[]
  }, Error>
  readonly steer: (input: SteerInput) => Effect.Effect<WorkflowStateFile, Error>
  readonly markComment: (input: MarkCommentInput) => Effect.Effect<WorkflowStateFile, Error>
  readonly markReviewComment: (input: MarkCommentInput) => Effect.Effect<WorkflowStateFile, Error>
  readonly recordComment: (input: RecordCommentInput) => Effect.Effect<WorkflowStateFile, Error>
  readonly addComment: (input: RecordCommentInput) => Effect.Effect<WorkflowStateFile, Error>
  readonly processAmendment: (input: AmendmentInput) => Effect.Effect<WorkflowStateFile, Error>
  readonly commitPlan: (input: CommitInput) => Effect.Effect<string, Error>
  readonly diff: (directory: string, workflowID: string, base?: string) => Effect.Effect<string, Error>
  readonly sessions: (state: WorkflowStateFile) => readonly WorkflowSession[]
  readonly branch: (state: WorkflowStateFile) => { plan: string; code: string | undefined }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Workflow") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const artifact = yield* WorkflowArtifact.Service
    const github = yield* WorkflowGithub.Service
    const approval = yield* WorkflowApproval.Service
    const scope = yield* WorkflowScope.Service

    const guardPostApprovalInput = Effect.fn("Workflow.guardPostApprovalInput")(function* (
      directory: string,
      state: WorkflowStateFile,
      body: string,
      githubCommentUrl?: string,
      path?: string,
    ) {
      if (!postApprovalState(state)) return undefined
      if (path) {
        const scopeResult = yield* scope.checkEdit(directory, state.workflow_id, [path])
        if (scopeResult.allowed) return undefined
        yield* approval.createAmendment(directory, state.workflow_id, scopeResult.reason)
        return {
          reason: scopeResult.reason,
          state: amendmentState(yield* get(directory, state.workflow_id), scopeResult.reason),
        }
      }

      const spec = yield* artifact.readArtifact(directory, state.workflow_id, "SPEC.md")
      const classification = yield* scope.checkComment(
        {
          id: githubCommentUrl ?? "user-steering",
          body,
          state: "open",
          source: "issue_comment",
          url: githubCommentUrl,
        },
        yield* scope.parseSpecContent(spec),
      )
      if (classification.tag !== "out_of_scope") return undefined
      yield* approval.createAmendment(directory, state.workflow_id, classification.reason)
      return {
        reason: classification.reason,
        state: amendmentState(yield* get(directory, state.workflow_id), classification.reason),
      }
    })

    const start = Effect.fn("Workflow.start")(function* (input: StartInput) {
      const workflowID = WorkflowState.createWorkflowID()
      const created = WorkflowState.now()
      const plannerSessionID = WorkflowState.createSessionID()
      const state: WorkflowStateFile = {
        workflow_id: workflowID,
        title: input.title,
        state: input.localDraft ? "drafting_spec" : "awaiting_plan_review",
        artifact_dir: WorkflowArtifact.relativeArtifactDir(workflowID),
        created_at: created,
        updated_at: created,
        plan_branch: planBranch(workflowID, input.title),
        code_branch: codeBranch(workflowID, input.title),
        current_task: "Draft plan artifacts",
        active_session_id: plannerSessionID,
        plan_pull_request: WorkflowState.emptyPullRequest(),
        code_pull_request: WorkflowState.emptyPullRequest(),
        sessions: [
          {
            id: plannerSessionID,
            role: "planner",
            status: "active",
            task: "Draft workflow plan artifacts",
            created_at: created,
            updated_at: created,
          },
        ],
      }

      const branch = yield* currentBranch(input.directory).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (branch && branch !== state.plan_branch) {
        yield* runRequired("git", ["checkout", "-b", state.plan_branch], input.directory)
      }

      yield* artifact.writeInitialArtifacts(input.directory, state)

      yield* bus.publish(WorkflowEvents.WorkflowCreated, {
        workflow_id: workflowID,
        title: input.title,
        state: state.state,
      })

      return state
    })

    const get = Effect.fn("Workflow.get")(function* (directory: string, workflowID: string) {
      return yield* artifact.readState(directory, workflowID)
    })

    const all = Effect.fn("Workflow.all")(function* (directory: string) {
      return yield* artifact.readAll(directory)
    })

    const validatePlan = Effect.fn("Workflow.validatePlan")(function* (
      directory: string,
      workflowID: string,
      base = "origin/dev",
    ) {
      const required = yield* artifact.validateRequired(directory, workflowID)
      if (!required.ok) return required
      return WorkflowArtifact.validatePlanOnlyFiles(workflowID, yield* changedFiles(directory, base))
    })

    const submitPlan = Effect.fn("Workflow.submitPlan")(function* (input: SubmitInput) {
      const state = yield* get(input.directory, input.workflowID)
      const validation = yield* validatePlan(input.directory, input.workflowID, input.base)
      yield* persist(artifact, input.directory, {
        ...WorkflowState.transitionOrCurrent(state, "submitting_plan_pull_request"),
        last_validation: validation,
        updated_at: WorkflowState.now(),
      })
      if (!validation.ok) return yield* Effect.fail(new Error(validation.summary))
      if (input.dryRun) return yield* get(input.directory, input.workflowID)

      const branch = yield* currentBranch(input.directory)
      const specHash = yield* artifact.hashApprovedArtifacts(input.directory, input.workflowID)
      yield* runRequired("git", ["push", "-u", "origin", branch], input.directory)

      const baseBranch = input.base ?? "dev"
      const existing = yield* ghPullRequestStateForBranch(input.directory, branch).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )

      if (!existing?.number) {
        yield* runRequired(
          "gh",
          [
            "pr",
            "create",
            "--base",
            baseBranch,
            "--head",
            branch,
            "--title",
            `Plan: ${state.title}`,
            "--body",
            prBody(state, specHash),
          ],
          input.directory,
        )
      } else {
        yield* runRequired(
          "gh",
          ["pr", "edit", String(existing.number), "--body", prBody(state, specHash)],
          input.directory,
        )
      }

      const repo = input.repo ?? ""
      const prState = repo
        ? yield* github.getPullRequestState(repo, existing?.number ?? 0).pipe(
            Effect.catch(() =>
              Effect.succeed({
                number: existing?.number ?? 0,
                url: undefined,
                branch,
                head_commit: undefined,
                review_state: "pending" as const,
                comments: [] as readonly ReviewComment[],
              }),
            ),
          )
        : yield* ghPullRequestStateForBranch(input.directory, branch).pipe(
            Effect.catch(() =>
              Effect.succeed({
                number: existing?.number ?? 0,
                url: undefined,
                branch,
                head_commit: undefined,
                review_state: "pending" as const,
                comments: [] as readonly ReviewComment[],
              }),
            ),
          )

      const next = withPlanReviewState({
        ...(yield* get(input.directory, input.workflowID)),
        plan_branch: branch,
        plan_pull_request: {
          number: prState.number,
          url: prState.url,
          branch: prState.branch,
          head_commit: prState.head_commit,
          review_state: prState.review_state,
          comments: prState.comments,
        },
        approved_spec_hash: WorkflowState.isApprovedReview(prState.review_state) && prState.head_commit ? specHash : state.approved_spec_hash,
        approved_plan_commit: WorkflowState.isApprovedReview(prState.review_state) && prState.head_commit ? prState.head_commit : state.approved_plan_commit,
      })
      yield* persist(artifact, input.directory, next)
      yield* artifact.appendDecision(input.directory, input.workflowID, {
        action: "workflow.plan_pull_request.submitted",
        previous_state: state.state,
        new_state: next.state,
        summary: `Submitted plan pull request ${prState.url ?? `#${prState.number}`}.`,
        evidence: prState.head_commit,
        pull_request: prState.number,
      })

      yield* bus.publish(WorkflowEvents.PlanPullRequestSubmitted, {
        workflow_id: input.workflowID,
        pull_request: prState.number,
        url: prState.url,
        head_commit: prState.head_commit,
        approved_spec_hash: next.approved_spec_hash,
      })

      return next
    })

    const validateCode = Effect.fn("Workflow.validateCode")(function* (
      directory: string,
      workflowID: string,
      base = "origin/dev",
    ) {
      const state = yield* get(directory, workflowID)
      yield* assertApprovedPlan(artifact, directory, state)
      const result = yield* scope.checkEdit(directory, workflowID, yield* changedFiles(directory, base))
      return {
        ok: result.allowed,
        checked_at: WorkflowState.now(),
        summary: result.reason,
        files: result.offending_files,
        allowed_paths: yield* artifact.readAllowedPaths(directory, workflowID),
      }
    })

    const scopeDrift = (directory: string, workflowID: string, files: readonly string[]) =>
      Effect.gen(function* () {
        const result = yield* scope.checkEdit(directory, workflowID, [...files])
        return {
          ok: result.allowed,
          checked_at: WorkflowState.now(),
          summary: result.reason,
          files: result.offending_files,
          allowed_paths: yield* artifact.readAllowedPaths(directory, workflowID),
        }
      })

    const revisePlan = Effect.fn("Workflow.revisePlan")(function* (input: RevisePlanInput) {
      const state = yield* get(input.directory, input.workflowID)
      const task = input.instruction ?? "Address plan review feedback"
      const next = WorkflowState.upsertSession(
        WorkflowState.transitionOrCurrent(
          {
            ...state,
            current_task: task,
            user_input_needed: undefined,
          },
          "addressing_plan_comments",
        ),
        nextSession(
          state.plan_pull_request.review_state === "approved" ? "amendment" : "planner",
          task,
          input.githubCommentUrl,
        ),
      )
      yield* persist(artifact, input.directory, next)
      yield* artifact.appendDecision(input.directory, input.workflowID, {
        action: "workflow.plan_revision.started",
        previous_state: state.state,
        new_state: next.state,
        summary: task,
        github_comment_url: input.githubCommentUrl,
      })
      return next
    })

    const runApprovedPlan = Effect.fn("Workflow.runApprovedPlan")(function* (input: RunInput) {
      const state = yield* get(input.directory, input.workflowID)
      const approvedHash = yield* assertApprovedPlan(artifact, input.directory, state)
      if (input.dryRun) return state

      const branch = state.code_branch ?? codeBranch(state.workflow_id, state.title)
      if (branch === state.plan_branch) {
        return yield* Effect.fail(new Error("Code execution must use a separate branch from the approved plan branch."))
      }
      yield* checkoutBranch(input.directory, branch)
      const next = WorkflowState.upsertSession(
        WorkflowState.withState(
          state.state === "plan_approved" ? state : WorkflowState.transitionOrCurrent(state, "plan_approved"),
          "executing",
        ),
        nextSession("executor", "Implement approved workflow plan"),
      )
      const withBranch = {
        ...next,
        code_branch: branch,
        approved_spec_hash: approvedHash,
        current_task: "Implement approved workflow plan",
        user_input_needed: undefined,
      }
      yield* persist(artifact, input.directory, withBranch)
      yield* artifact.appendDecision(input.directory, input.workflowID, {
        action: "workflow.approved_plan.run",
        previous_state: state.state,
        new_state: withBranch.state,
        summary: `Execution state prepared on code branch ${branch}. Agent execution was not invoked.`,
        evidence: approvedHash,
      })

      yield* bus.publish(WorkflowEvents.ExecutionStarted, {
        workflow_id: input.workflowID,
        code_branch: branch,
        approved_spec_hash: approvedHash,
      })

      return withBranch
    })

    const run = runApprovedPlan

    const submitCode = Effect.fn("Workflow.submitCode")(function* (input: SubmitInput) {
      const state = yield* get(input.directory, input.workflowID)
      yield* assertApprovedPlan(artifact, input.directory, state)
      const validation = yield* validateCode(
        input.directory,
        input.workflowID,
        input.base ?? state.approved_plan_commit ?? "origin/dev",
      )
      yield* persist(artifact, input.directory, {
        ...WorkflowState.transitionOrCurrent(state, "submitting_code_pull_request"),
        last_validation: validation,
        updated_at: WorkflowState.now(),
      })
      if (!validation.ok) return yield* Effect.fail(new Error(validation.summary))
      if (input.dryRun) return yield* get(input.directory, input.workflowID)

      const branch = yield* currentBranch(input.directory)
      if (branch === state.plan_branch) {
        return yield* Effect.fail(new Error("Code pull request must use a branch separate from the plan pull request."))
      }
      yield* runRequired("git", ["push", "-u", "origin", branch], input.directory)
      const current = {
        ...(yield* get(input.directory, input.workflowID)),
        code_branch: branch,
      }

      const existing = yield* ghPullRequestStateForBranch(input.directory, branch).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )

      const baseBranch = input.base ?? "dev"
      if (existing?.number && existing.number === state.plan_pull_request.number) {
        return yield* Effect.fail(new Error("Code pull request must be separate from the plan pull request."))
      }
      if (!existing?.number) {
        yield* runRequired(
          "gh",
          [
            "pr",
            "create",
            "--base",
            baseBranch,
            "--head",
            branch,
            "--title",
            `Code: ${current.title}`,
            "--body",
            codePrBody(current),
          ],
          input.directory,
        )
      } else {
        yield* runRequired(
          "gh",
          ["pr", "edit", String(existing.number), "--body", codePrBody(current)],
          input.directory,
        )
      }

      const repo = input.repo ?? ""
      const prState = repo && existing?.number
        ? yield* github.getPullRequestState(repo, existing.number).pipe(
            Effect.catch(() =>
              Effect.succeed({
                number: existing?.number ?? 0,
                url: undefined,
                branch,
                head_commit: undefined,
                review_state: "pending" as const,
                comments: [] as readonly ReviewComment[],
              }),
            ),
          )
        : yield* ghPullRequestStateForBranch(input.directory, branch).pipe(
            Effect.catch(() =>
              Effect.succeed({
                number: existing?.number ?? 0,
                url: undefined,
                branch,
                head_commit: undefined,
                review_state: "pending" as const,
                comments: [] as readonly ReviewComment[],
              }),
            ),
          )

      const next = withCodeReviewState({
        ...(yield* get(input.directory, input.workflowID)),
        code_branch: branch,
        code_pull_request: {
          number: prState.number,
          url: prState.url,
          branch: prState.branch,
          head_commit: prState.head_commit,
          review_state: prState.review_state,
          comments: prState.comments,
        },
      })
      yield* persist(artifact, input.directory, next)
      yield* artifact.appendDecision(input.directory, input.workflowID, {
        action: "workflow.code_pull_request.submitted",
        previous_state: state.state,
        new_state: next.state,
        summary: `Submitted code pull request ${prState.url ?? `#${prState.number}`}.`,
        evidence: prState.head_commit,
        pull_request: prState.number,
      })

      yield* bus.publish(WorkflowEvents.CodePullRequestSubmitted, {
        workflow_id: input.workflowID,
        pull_request: prState.number,
        url: prState.url,
        head_commit: prState.head_commit,
      })

      return next
    })

    const syncGithub = Effect.fn("Workflow.syncGithub")(function* (input: SyncInput) {
      const state = yield* get(input.directory, input.workflowID)
      if (!state.plan_pull_request.number && !state.code_pull_request.number) {
        return yield* Effect.fail(new Error("No GitHub pull request is recorded for this workflow."))
      }

      const repo = input.repo ?? ""

      const plan = state.plan_pull_request.number && repo
        ? yield* github.getPullRequestState(repo, state.plan_pull_request.number).pipe(
            Effect.catch(() => Effect.succeed(state.plan_pull_request)),
          )
        : state.plan_pull_request

      const code = state.code_pull_request.number && repo
        ? yield* github.getPullRequestState(repo, state.code_pull_request.number).pipe(
            Effect.catch(() => Effect.succeed(state.code_pull_request)),
          )
        : state.code_pull_request

      const currentHash = yield* artifact.hashApprovedArtifacts(input.directory, input.workflowID)
      const planDrift = state.approved_spec_hash !== undefined && currentHash !== state.approved_spec_hash
      const reviewedState = withCodeReviewState(
        withPlanReviewState({
          ...state,
          plan_pull_request: {
            ...plan,
            comments: WorkflowGithub.mergeCommentState(state.plan_pull_request.comments, plan.comments),
          },
          code_pull_request: {
            ...code,
            comments: WorkflowGithub.mergeCommentState(state.code_pull_request.comments, code.comments),
          },
          approved_spec_hash: WorkflowState.isApprovedReview(plan.review_state) && !planDrift && plan.head_commit
            ? (state.approved_spec_hash ?? currentHash)
            : state.approved_spec_hash,
          approved_plan_commit: WorkflowState.isApprovedReview(plan.review_state) && !planDrift && plan.head_commit
            ? (state.approved_plan_commit ?? plan.head_commit)
            : state.approved_plan_commit,
        }),
      )
      const next = planDrift
        ? WorkflowState.transitionOrCurrent(
            {
              ...reviewedState,
              approved_spec_hash: undefined,
              approved_plan_commit: undefined,
              user_input_needed: "Approved workflow artifacts changed after plan approval.",
              plan_pull_request: {
                ...reviewedState.plan_pull_request,
                review_state: "changes_requested",
                comments: [
                  ...reviewedState.plan_pull_request.comments.filter((comment) => comment.id !== "local-approved-plan-drift"),
                  {
                    id: "local-approved-plan-drift",
                    body: "Approved SPEC.md, TASKS.md, or IMPACT.md changed after plan approval. Re-approval is required before implementation can continue.",
                    state: "open",
                    source: "review" as const,
                    created_at: WorkflowState.now(),
                    updated_at: WorkflowState.now(),
                  },
                ],
              },
            },
            postApprovalState(state) ? "needs_amendment" : "addressing_plan_comments",
          )
        : reviewedState

      yield* persist(artifact, input.directory, next)
      yield* artifact.appendDecision(input.directory, input.workflowID, {
        action: planDrift ? "workflow.approved_plan.invalidated" : "workflow.github.synced",
        previous_state: state.state,
        new_state: next.state,
        summary: planDrift
          ? "Approved workflow artifacts changed after approval. Plan approval evidence was cleared."
          : `Synced GitHub state with ${WorkflowState.openComments(next).length} open comment(s).`,
        evidence: planDrift ? state.approved_spec_hash : plan.url,
        pull_request: plan.number,
      })

      if (WorkflowState.isApprovedReview(plan.review_state) && !WorkflowState.isApprovedReview(state.plan_pull_request.review_state)) {
        yield* bus.publish(WorkflowEvents.PlanReviewApproved, {
          workflow_id: input.workflowID,
          pull_request: plan.number ?? 0,
          approved_commit: plan.head_commit ?? "",
          approved_spec_hash: next.approved_spec_hash ?? "",
        })
      }

      if (next.state === "completed" && state.state !== "completed") {
        yield* bus.publish(WorkflowEvents.WorkflowCompleted, {
          workflow_id: input.workflowID,
          pull_request: code.number ?? 0,
        })
      }

      return next
    })

    const pause = Effect.fn("Workflow.pause")(function* (directory: string, workflowID: string) {
      const state = yield* get(directory, workflowID)
      const next = WorkflowState.withState(state, "paused")
      yield* persist(artifact, directory, next)
      yield* artifact.appendDecision(directory, workflowID, {
        action: "workflow.paused",
        previous_state: state.state,
        new_state: next.state,
        summary: "Workflow paused by user.",
      })
      return next
    })

    const resume = Effect.fn("Workflow.resume")(function* (directory: string, workflowID: string) {
      const state = yield* get(directory, workflowID)
      const next = WorkflowState.withState(
        state,
        WorkflowState.isApprovedReview(state.plan_pull_request.review_state) ? "plan_approved" : "awaiting_plan_review",
      )
      yield* persist(artifact, directory, next)
      yield* artifact.appendDecision(directory, workflowID, {
        action: "workflow.resumed",
        previous_state: state.state,
        new_state: next.state,
        summary: "Workflow resumed by user.",
      })
      return next
    })

    const findSession = (state: WorkflowStateFile, sessionID: string) =>
      state.sessions.find((session) => session.id === sessionID)

    const getSession = Effect.fn("Workflow.getSession")(function* (
      directory: string,
      workflowID: string,
      sessionID: string,
    ) {
      const session = findSession(yield* get(directory, workflowID), sessionID)
      if (session) return session
      return yield* Effect.fail(new Error(`Workflow session not found: ${sessionID}`))
    })

    const sessionContext = Effect.fn("Workflow.sessionContext")(function* (
      directory: string,
      workflowID: string,
      sessionID: string,
    ) {
      const state = yield* get(directory, workflowID)
      const session = findSession(state, sessionID)
      if (!session) return yield* Effect.fail(new Error(`Workflow session not found: ${sessionID}`))
      const [spec, tasks, impact, githubMd, decisions] = yield* Effect.all(
        [
          artifact.readArtifact(directory, workflowID, "SPEC.md"),
          artifact.readArtifact(directory, workflowID, "TASKS.md"),
          artifact.readArtifact(directory, workflowID, "IMPACT.md"),
          artifact.readArtifact(directory, workflowID, "GITHUB.md"),
          artifact.readArtifact(directory, workflowID, "DECISIONS.md"),
        ],
        { concurrency: 5 },
      )
      return {
        workflow: state,
        session,
        artifacts: {
          "SPEC.md": spec,
          "TASKS.md": tasks,
          "IMPACT.md": impact,
          "GITHUB.md": githubMd,
          "DECISIONS.md": decisions,
        },
        open_comments: WorkflowState.openComments(state),
        allowed_paths: WorkflowArtifact.parseAllowedPaths(impact),
      }
    })

    const context = sessionContext

    const steer = Effect.fn("Workflow.steer")(function* (input: SteerInput) {
      const state = yield* get(input.directory, input.workflowID)
      const amendment = yield* guardPostApprovalInput(
        input.directory,
        state,
        input.instruction,
        input.githubCommentUrl,
      )
      if (amendment) {
        yield* persist(artifact, input.directory, amendment.state)
        yield* artifact.appendDecision(input.directory, input.workflowID, {
          action: "workflow.session.steering.requires_amendment",
          previous_state: state.state,
          new_state: amendment.state.state,
          actor: "user",
          summary: amendment.reason,
          github_comment_url: input.githubCommentUrl,
        })
        return amendment.state
      }
      const next = WorkflowState.updateSession(
        {
          ...state,
          current_task: input.instruction,
          user_input_needed: undefined,
        },
        input.sessionID,
        {
          status: "active",
          task: input.instruction,
          github_comment_url: input.githubCommentUrl,
        },
      )
      yield* persist(artifact, input.directory, next)
      yield* artifact.appendDecision(input.directory, input.workflowID, {
        action: "workflow.session.steered",
        previous_state: state.state,
        new_state: next.state,
        actor: "user",
        summary: input.instruction,
        github_comment_url: input.githubCommentUrl,
      })

      yield* bus.publish(WorkflowEvents.SessionSteered, {
        workflow_id: input.workflowID,
        session_id: input.sessionID,
        instruction: input.instruction,
        github_comment_url: input.githubCommentUrl,
      })

      return next
    })

    const markComment = Effect.fn("Workflow.markComment")(function* (input: MarkCommentInput) {
      const state = yield* get(input.directory, input.workflowID)
      const next = withCommentBookkeepingState(
        WorkflowState.markComment(state, input.pullRequest, input.commentID, input.state),
        input.pullRequest,
      )
      yield* persist(artifact, input.directory, next)
      yield* artifact.appendDecision(input.directory, input.workflowID, {
        action: "workflow.comment.marked",
        previous_state: state.state,
        new_state: next.state,
        summary: input.summary ?? `Marked ${input.pullRequest} comment ${input.commentID} as ${input.state}.`,
        pull_request: input.pullRequest === "plan" ? next.plan_pull_request.number : next.code_pull_request.number,
      })
      return next
    })

    const markReviewComment = markComment

    const recordComment = Effect.fn("Workflow.recordComment")(function* (input: RecordCommentInput) {
      const state = yield* get(input.directory, input.workflowID)
      const recorded = WorkflowState.appendComment(state, input.pullRequest, input.comment)
      const guarded = input.pullRequest === "code"
        ? yield* guardPostApprovalInput(
            input.directory,
            recorded,
            input.comment.body,
            input.comment.url,
            input.comment.path,
          )
        : undefined
      const next = guarded
        ? amendmentState(
          {
            ...guarded.state,
            code_pull_request: {
              ...recorded.code_pull_request,
              comments: recorded.code_pull_request.comments.map((comment) =>
                comment.id === input.comment.id
                  ? {
                      ...comment,
                      state: "out_of_scope" as const,
                      updated_at: WorkflowState.now(),
                    }
                  : comment,
              ),
            },
          },
          guarded.reason,
        )
        : withCommentBookkeepingState(recorded, input.pullRequest)
      yield* persist(artifact, input.directory, next)
      yield* artifact.appendDecision(input.directory, input.workflowID, {
        action: guarded ? "workflow.comment.requires_amendment" : "workflow.comment.recorded",
        previous_state: state.state,
        new_state: next.state,
        summary: guarded ? guarded.reason : `Recorded ${input.pullRequest} comment ${input.comment.id}.`,
        github_comment_url: input.comment.url,
        pull_request: input.pullRequest === "plan" ? next.plan_pull_request.number : next.code_pull_request.number,
      })
      return next
    })

    const addComment = recordComment

    const processAmendment = Effect.fn("Workflow.processAmendment")(function* (input: AmendmentInput) {
      const state = yield* get(input.directory, input.workflowID)
      const resolvedAt = WorkflowState.now()
      const amendment = yield* artifact.readArtifact(input.directory, input.workflowID, "AMENDMENT.md").pipe(
        Effect.catch(() => Effect.succeed("# Amendment\n\nNo amendment details were recorded.\n")),
      )
      yield* artifact.writeArtifact(
        input.directory,
        input.workflowID,
        "AMENDMENT.md",
        withAmendmentStatus(amendment, input.approve ? "approved" : "rejected", resolvedAt),
      )
      const next = WorkflowState.withState(state, input.approve ? "executing" : "paused")
      yield* persist(artifact, input.directory, next)
      yield* artifact.appendDecision(input.directory, input.workflowID, {
        action: input.approve ? "workflow.amendment.approved" : "workflow.amendment.rejected",
        previous_state: state.state,
        new_state: next.state,
        actor: "user",
        summary: input.reason ?? (input.approve ? "Amendment approved by user." : "Amendment rejected by user."),
      })
      return next
    })

    const commitPlan = Effect.fn("Workflow.commitPlan")(function* (input: CommitInput) {
      yield* runRequired(
        "git",
        ["add", WorkflowArtifact.relativeArtifactDir(input.workflowID)],
        input.directory,
      )
      yield* runRequired(
        "git",
        ["commit", "-m", input.message ?? `Add workflow plan ${input.workflowID}`],
        input.directory,
      )
      return yield* headCommit(input.directory)
    })

    const diff = Effect.fn("Workflow.diff")(function* (directory: string, workflowID: string, base = "origin/dev") {
      yield* get(directory, workflowID)
      const mergeBase = yield* execCommand("git", ["merge-base", base, "HEAD"], directory)
      return yield* runRequired(
        "git",
        ["diff", mergeBase.exitCode === 0 ? mergeBase.stdout : base, "--", "."],
        directory,
      )
    })

    const sessions = (state: WorkflowStateFile) => state.sessions

    const branchFn = (state: WorkflowStateFile) => ({
      plan: state.plan_branch,
      code: state.code_branch,
    })

    return Service.of({
      start,
      get,
      all,
      validatePlan,
      submitPlan,
      validateCode,
      scopeDrift,
      revisePlan,
      runApprovedPlan,
      run,
      submitCode,
      syncGithub,
      pause,
      resume,
      findSession,
      getSession,
      sessionContext,
      context,
      steer,
      markComment,
      markReviewComment,
      recordComment,
      addComment,
      processAmendment,
      commitPlan,
      diff,
      sessions,
      branch: branchFn,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(WorkflowGithub.defaultLayer),
  Layer.provide(WorkflowApproval.defaultLayer),
  Layer.provide(WorkflowScope.defaultLayer),
  Layer.provide(WorkflowArtifact.defaultLayer),
  Layer.provide(Bus.layer),
)

export * as Workflow from "./workflow"

// Backward-compatible async wrappers for tests and non-Effect consumers
import { makeRuntime } from "@/effect/run-service"

const { runPromise } = makeRuntime(
  Service,
  layer.pipe(
    Layer.provide(WorkflowGithub.defaultLayer),
    Layer.provide(WorkflowApproval.defaultLayer),
    Layer.provide(WorkflowScope.defaultLayer),
    Layer.provide(WorkflowArtifact.defaultLayer),
    Layer.provide(Layer.succeed(Bus.Service, Bus.Service.of({
      publish: () => Effect.void,
      subscribe: () => Stream.empty as never,
      subscribeAll: () => Stream.empty as never,
      subscribeCallback: () => Effect.succeed(() => {}),
      subscribeAllCallback: () => Effect.succeed(() => {}),
    } as import("@/bus").Interface))),
  ),
)

export async function start(input: StartInput) {
  return runPromise((svc) => svc.start(input))
}

export async function get(directory: string, workflowID: string) {
  return runPromise((svc) => svc.get(directory, workflowID))
}

export async function all(directory: string) {
  return runPromise((svc) => svc.all(directory))
}

export async function validatePlan(directory: string, workflowID: string, base = "origin/dev") {
  return runPromise((svc) => svc.validatePlan(directory, workflowID, base))
}

export async function submitPlan(input: SubmitInput) {
  return runPromise((svc) => svc.submitPlan(input))
}

export async function validateCode(directory: string, workflowID: string, base = "origin/dev") {
  return runPromise((svc) => svc.validateCode(directory, workflowID, base))
}

export async function scopeDrift(directory: string, workflowID: string, files: readonly string[]) {
  return runPromise((svc) => svc.scopeDrift(directory, workflowID, files))
}

export async function revisePlan(input: RevisePlanInput) {
  return runPromise((svc) => svc.revisePlan(input))
}

export async function runApprovedPlan(input: RunInput) {
  return runPromise((svc) => svc.runApprovedPlan(input))
}

export async function run(input: RunInput) {
  return runPromise((svc) => svc.run(input))
}

export async function submitCode(input: SubmitInput) {
  return runPromise((svc) => svc.submitCode(input))
}

export async function syncGithub(input: SyncInput) {
  return runPromise((svc) => svc.syncGithub(input))
}

export async function pause(directory: string, workflowID: string) {
  return runPromise((svc) => svc.pause(directory, workflowID))
}

export async function resume(directory: string, workflowID: string) {
  return runPromise((svc) => svc.resume(directory, workflowID))
}

export function findSession(state: WorkflowStateFile, sessionID: string) {
  return state.sessions.find((session) => session.id === sessionID)
}

export async function getSession(directory: string, workflowID: string, sessionID: string) {
  return runPromise((svc) => svc.getSession(directory, workflowID, sessionID))
}

export async function sessionContext(directory: string, workflowID: string, sessionID: string) {
  return runPromise((svc) => svc.sessionContext(directory, workflowID, sessionID))
}

export async function steer(input: SteerInput) {
  return runPromise((svc) => svc.steer(input))
}

export async function markComment(input: MarkCommentInput) {
  return runPromise((svc) => svc.markComment(input))
}

export async function markReviewComment(input: MarkCommentInput) {
  return runPromise((svc) => svc.markReviewComment(input))
}

export async function recordComment(input: RecordCommentInput) {
  return runPromise((svc) => svc.recordComment(input))
}

export async function processAmendment(input: AmendmentInput) {
  return runPromise((svc) => svc.processAmendment(input))
}

export async function commitPlan(input: CommitInput) {
  return runPromise((svc) => svc.commitPlan(input))
}

export async function diff(directory: string, workflowID: string, base = "origin/dev") {
  return runPromise((svc) => svc.diff(directory, workflowID, base))
}

export function sessions(state: WorkflowStateFile) {
  return state.sessions
}

export function branch(state: WorkflowStateFile) {
  return { plan: state.plan_branch, code: state.code_branch }
}
