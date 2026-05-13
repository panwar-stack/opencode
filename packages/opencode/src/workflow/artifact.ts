import { createHash } from "crypto"
import path from "path"
import { mkdir, readdir, appendFile } from "fs/promises"
import { Context, Effect, Layer } from "effect"
import { WorkflowState, type WorkflowStateFile } from "./state"

export const ArtifactFiles = ["SPEC.md", "TASKS.md", "IMPACT.md", "GITHUB.md", "STATE.json", "DECISIONS.md", "AMENDMENT.md"] as const
export const RequiredArtifactFiles = ["SPEC.md", "TASKS.md", "IMPACT.md", "GITHUB.md", "STATE.json", "DECISIONS.md"] as const
const ApprovedArtifactFiles = new Set<ArtifactFile>(["SPEC.md", "TASKS.md", "IMPACT.md"])

export type ArtifactFile = (typeof ArtifactFiles)[number]

export type ValidationResult = {
  readonly ok: boolean
  readonly summary: string
  readonly checked_at: string
  readonly files?: readonly string[]
  readonly allowed_paths?: readonly string[]
}

export type DecisionInput = {
  readonly action: string
  readonly session_id?: string
  readonly previous_state?: string
  readonly new_state?: string
  readonly actor?: string
  readonly summary: string
  readonly evidence?: string
  readonly pull_request?: number
  readonly github_comment_url?: string
}

export function workflowRoot(directory: string) {
  return path.join(directory, ".opencode", "workflows")
}

export function workflowDir(directory: string, workflowID: string) {
  return path.join(workflowRoot(directory), workflowID)
}

export function artifactPath(directory: string, workflowID: string, file: ArtifactFile) {
  return path.join(workflowDir(directory, workflowID), file)
}

export function relativeArtifactDir(workflowID: string) {
  return path.posix.join(".opencode", "workflows", workflowID)
}

function normalizeRepoPath(file: string) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "")
}

function globToRegExp(pattern: string) {
  const source = normalizeRepoPath(pattern)
    .split("")
    .map((char, index, chars) => {
      if (char === "*" && chars[index + 1] === "*") return "\0"
      if (char === "*" && chars[index - 1] === "*") return ""
      if (char === "*") return "[^/]*"
      if ("\\^$+?.()|{}[]".includes(char)) return `\\${char}`
      return char
    })
    .join("")
    .replaceAll("\0", ".*")
  return new RegExp(`^${source}$`)
}

function parseSection(impact: string, header: string): readonly string[] {
  const start = impact.split(/\r?\n/).findIndex((line) => new RegExp(`^##\\s+${header}\\s*$`, "i").test(line.trim()))
  if (start === -1) return []
  return impact
    .split(/\r?\n/)
    .slice(start + 1)
    .filter((line, index, lines) => lines.slice(0, index).every((previous) => !/^##\s+/.test(previous.trim())))
    .map((line) => line.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((line): line is string => line !== undefined && line.length > 0)
    .map((line) => line.replace(/^`|`$/g, ""))
}

export function parseAllowedPaths(impact: string): readonly string[] {
  return parseSection(impact, "Allowed Paths")
}

function normalizeAllowedDirectory(directory: string) {
  const normalized = normalizeRepoPath(directory)
  if (normalized.endsWith("/**")) return normalized
  if (normalized.endsWith("/")) return `${normalized}**`
  return `${normalized}/**`
}

export function parseImpactAllowedPaths(impact: string): readonly string[] {
  return [
    ...parseAllowedPaths(impact),
    ...parseSection(impact, "Allowed Directories").map(normalizeAllowedDirectory),
    ...parseSection(impact, "Expected New Files"),
  ]
}

export function matchesAllowedPath(file: string, allowedPath: string) {
  const normalized = normalizeRepoPath(file)
  const allowed = normalizeRepoPath(allowedPath)
  if (allowed.endsWith("/**")) return normalized === allowed.slice(0, -3) || normalized.startsWith(allowed.slice(0, -2))
  if (allowed.endsWith("/")) return normalized.startsWith(allowed)
  if (!allowed.includes("*")) return normalized === allowed || normalized.startsWith(`${allowed}/`)
  return globToRegExp(allowed).test(normalized)
}

export function permissionPatternForAllowedPath(allowedPath: string) {
  const allowed = normalizeRepoPath(allowedPath)
  if (allowed.endsWith("/**")) return allowed
  if (allowed.endsWith("/")) return `${allowed}**`
  return allowed
}

function normalizeApprovedArtifact(file: ArtifactFile, content: string) {
  if (file !== "TASKS.md") return content
  return content
    .split(/\r?\n/)
    .map((line) =>
      /^\s*-\s+\[[ x]\]\s+/.test(line)
        ? line
            .replace(/^\s*-\s+\[[ x]\]/, "- [ ]")
            .replace(/\s*\|\s*status:\s*[^|]+/i, "")
            .replace(/\s*\|\s*evidence:\s*[^|]+/i, "")
            .replace(/\s*\|\s*github:\s*none\s*$/i, "")
        : line,
    )
    .join("\n")
}

export function validatePlanOnlyFiles(workflowID: string, files: readonly string[]): ValidationResult {
  const allowed = `${relativeArtifactDir(workflowID)}/`
  const alternateAllowed = allowed.startsWith(".") ? allowed.slice(1) : allowed
  const invalid = files.filter((file) => !file.startsWith(allowed) && !file.startsWith(alternateAllowed))
  if (invalid.length === 0) {
    return {
      ok: true,
      checked_at: WorkflowState.now(),
      summary: "Changed files are limited to workflow artifacts.",
      files,
    }
  }

  return {
    ok: false,
    checked_at: WorkflowState.now(),
    summary: `Plan branch contains non-workflow changes: ${invalid.join(", ")}`,
    files: invalid,
  }
}

export function validateAllowedFiles(allowedPaths: readonly string[], files: readonly string[]): ValidationResult {
  const invalid = files
    .map(normalizeRepoPath)
    .filter((file) => !allowedPaths.some((allowedPath) => matchesAllowedPath(file, allowedPath)))
  if (invalid.length === 0) {
    return {
      ok: true,
      checked_at: WorkflowState.now(),
      summary: "Changed files are within the approved impact boundary.",
      files,
      allowed_paths: allowedPaths,
    }
  }

  return {
    ok: false,
    checked_at: WorkflowState.now(),
    summary: `Changed files outside approved impact boundary: ${invalid.join(", ")}`,
    files: invalid,
    allowed_paths: allowedPaths,
  }
}

function hasHeading(content: string, heading: string) {
  return new RegExp(`^##\\s+${heading}\\s*$`, "im").test(content)
}

function sectionContent(content: string, heading: string) {
  const lines = content.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\s*$`, "i").test(line.trim()))
  if (start === -1) return ""
  const end = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line.trim()))
  return lines
    .slice(start + 1, end === -1 ? undefined : start + 1 + end)
    .join("\n")
    .trim()
}

const placeholderPatterns = [
  /define the requested behavior/i,
  /document the current behavior before implementation/i,
  /document the proposed behavior after implementation/i,
  /document the services, modules, and integration points involved/i,
  /list files expected to change/i,
  /add targeted validation commands for each task/i,
]

function hasPlaceholderContent(content: string) {
  return placeholderPatterns.some((pattern) => pattern.test(content))
}

const placeholderTaskTitles = new Set([
  "Complete reviewed specification",
  "Validate impact boundary",
  "Submit plan pull request",
])

function hasPlaceholderTask(line: string) {
  const title = line.match(/^\s*-\s+\[[ x]\]\s+\S+\s+\|\s+([^|]+)/)?.[1]?.trim()
  return title ? placeholderTaskTitles.has(title) : false
}

function hasPlaceholderImpact(content: string) {
  const allowedPaths = parseAllowedPaths(content)
  if (allowedPaths.length !== 1 || !/^\.opencode\/workflows\/wf_[^/]+\/\*\*$/.test(allowedPaths[0] ?? "")) return false
  return [
    "Expected New Files",
    "Dependency Changes",
    "Data Model Changes",
    "Migration Risk",
    "User-Visible Changes",
  ].some((heading) => /none (identified|approved)/i.test(sectionContent(content, heading)))
}

function validateArtifactStructure(contents: Record<Exclude<ArtifactFile, "AMENDMENT.md">, string>) {
  const missing = [
    ...[
      "Summary",
      "Goals",
      "Non-Goals",
      "Current Behavior",
      "Proposed Behavior",
      "Architecture",
      "Expected Files",
      "Data Model Changes",
      "CLI/TUI Changes",
      "GitHub PR Flow",
      "Test Plan",
      "Rollback Plan",
      "Open Questions",
    ].filter((heading) => !hasHeading(contents["SPEC.md"], heading)).map((heading) => `SPEC.md#${heading}`),
    ...[
      "Allowed Paths",
      "Expected New Files",
      "Forbidden Paths",
      "Dependency Changes",
      "Data Model Changes",
      "Security Considerations",
      "Migration Risk",
      "User-Visible Changes",
      "Review Response Boundaries",
      "Rollback Notes",
    ].filter((heading) => !hasHeading(contents["IMPACT.md"], heading)).map((heading) => `IMPACT.md#${heading}`),
  ]

  const taskLines = contents["TASKS.md"]
    .split(/\r?\n/)
    .filter((line) => /^-\s+\[[ x]\]\s+/.test(line.trim()))
  const malformedTasks = taskLines.filter((line) =>
    !/\|\s*files:\s*.+\|\s*validation:\s*.+\|\s*status:\s*.+\|\s*evidence:\s*.+\|\s*github:\s*.+/i.test(line),
  )
  if (taskLines.length === 0) missing.push("TASKS.md#tasks")
  if (malformedTasks.length > 0) missing.push("TASKS.md#task-metadata")
  if (
    [
      "Goals",
      "Current Behavior",
      "Proposed Behavior",
      "Architecture",
      "Expected Files",
      "Test Plan",
    ].some((heading) => hasPlaceholderContent(sectionContent(contents["SPEC.md"], heading)))
  ) {
    missing.push("SPEC.md#placeholder-content")
  }
  if (taskLines.some(hasPlaceholderTask)) missing.push("TASKS.md#placeholder-content")
  if (hasPlaceholderImpact(contents["IMPACT.md"])) missing.push("IMPACT.md#placeholder-content")
  if (!/^#\s+GitHub\s*$/im.test(contents["GITHUB.md"])) missing.push("GITHUB.md#GitHub")
  return missing
}

function invalidatedPlanState(state: WorkflowStateFile): WorkflowStateFile {
  return WorkflowState.transitionOrCurrent(
    {
      ...state,
      approved_spec_hash: undefined,
      approved_plan_commit: undefined,
      plan_approval: undefined,
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
}

export interface Interface {
  readonly readState: (directory: string, workflowID: string) => Effect.Effect<WorkflowStateFile>
  readonly readArtifact: (directory: string, workflowID: string, file: ArtifactFile) => Effect.Effect<string>
  readonly writeArtifact: (directory: string, workflowID: string, file: ArtifactFile, content: string) => Effect.Effect<void>
  readonly writeState: (directory: string, state: WorkflowStateFile) => Effect.Effect<void>
  readonly list: (directory: string) => Effect.Effect<readonly string[]>
  readonly readAll: (directory: string) => Effect.Effect<readonly WorkflowStateFile[]>
  readonly validateRequired: (directory: string, workflowID: string) => Effect.Effect<ValidationResult>
  readonly hashApprovedArtifacts: (directory: string, workflowID: string) => Effect.Effect<string>
  readonly writeInitialArtifacts: (directory: string, state: WorkflowStateFile) => Effect.Effect<void>
  readonly appendDecision: (directory: string, workflowID: string, input: DecisionInput) => Effect.Effect<void>
  readonly writeGithubSummary: (directory: string, state: WorkflowStateFile) => Effect.Effect<void>
  readonly readAllowedPaths: (directory: string, workflowID: string) => Effect.Effect<readonly string[]>
  readonly validateScopeDrift: (
    directory: string,
    workflowID: string,
    files: readonly string[],
  ) => Effect.Effect<ValidationResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowArtifact") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const exists = (file: string) => Effect.promise(() => Bun.file(file).exists())

    const readState = Effect.fn("WorkflowArtifact.readState")(function* (directory: string, workflowID: string) {
      const state = yield* Effect.promise(() => Bun.file(artifactPath(directory, workflowID, "STATE.json")).json()).pipe(
        Effect.map((json) => json as WorkflowStateFile),
      )
      return {
        ...state,
        request: state.request ?? state.title,
        open_github_comments: WorkflowState.openComments(state),
      }
    })

    const readArtifact = Effect.fn("WorkflowArtifact.readArtifact")(function* (
      directory: string,
      workflowID: string,
      file: ArtifactFile,
    ) {
      return yield* Effect.promise(() => Bun.file(artifactPath(directory, workflowID, file)).text())
    })

    const writeArtifact = Effect.fn("WorkflowArtifact.writeArtifact")(function* (
      directory: string,
      workflowID: string,
      file: ArtifactFile,
      content: string,
    ) {
      yield* Effect.promise(() =>
        Bun.write(artifactPath(directory, workflowID, file), content.endsWith("\n") ? content : `${content}\n`),
      )
      if (!ApprovedArtifactFiles.has(file)) return
      const state = yield* readState(directory, workflowID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!state?.approved_spec_hash) return
      const currentHash = yield* hashApprovedArtifacts(directory, workflowID)
      if (currentHash === state.approved_spec_hash) return
      const next = invalidatedPlanState(state)
      yield* writeState(directory, next)
      yield* appendDecision(directory, workflowID, {
        action: "workflow.approved_plan.invalidated",
        previous_state: state.state,
        new_state: next.state,
        summary: "Approved workflow artifacts changed after approval. Plan approval evidence was cleared.",
        evidence: state.approved_spec_hash,
        pull_request: state.plan_pull_request.number,
      })
    })

    const writeState = Effect.fn("WorkflowArtifact.writeState")(function* (
      directory: string,
      state: WorkflowStateFile,
    ) {
      const normalized = {
        ...state,
        request: state.request ?? state.title,
        open_github_comments: WorkflowState.openComments(state),
      }
      yield* Effect.promise(() =>
        Bun.write(
          artifactPath(directory, state.workflow_id, "STATE.json"),
          `${JSON.stringify(normalized, null, 2)}\n`,
        ),
      )
    })

    const list = Effect.fn("WorkflowArtifact.list")(function* (directory: string) {
      const root = workflowRoot(directory)
      const entries = yield* Effect.tryPromise({
        try: () => readdir(root, { withFileTypes: true }),
        catch: () => undefined,
      }).pipe(
        Effect.catch(() => Effect.succeed([])),
      )
      return entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("wf_"))
        .map((entry) => entry.name)
        .toSorted()
    })

    const readAll = Effect.fn("WorkflowArtifact.readAll")(function* (directory: string) {
      const ids = yield* list(directory)
      return yield* Effect.all(ids.map((id) => readState(directory, id)))
    })

    const validateRequired = Effect.fn("WorkflowArtifact.validateRequired")(function* (
      directory: string,
      workflowID: string,
    ) {
      const results = yield* Effect.all(
        RequiredArtifactFiles.map((file) =>
          Effect.gen(function* () {
            const present = yield* exists(artifactPath(directory, workflowID, file))
            return { file, present }
          }),
        ),
      )
      const missing = results.filter((r) => !r.present).map((r) => r.file)

      if (missing.length > 0) {
        return {
          ok: false,
          checked_at: WorkflowState.now(),
          summary: `Missing required workflow artifacts: ${missing.join(", ")}`,
          files: missing,
        }
      }

      const contentEntries = yield* Effect.all(
        RequiredArtifactFiles.map((file) =>
          readArtifact(directory, workflowID, file).pipe(Effect.map((content) => [file, content] as const)),
        ),
        { concurrency: "unbounded" },
      )
      const structureMissing = validateArtifactStructure(Object.fromEntries(contentEntries) as Record<Exclude<ArtifactFile, "AMENDMENT.md">, string>)

      if (structureMissing.length === 0) {
        return {
          ok: true,
          checked_at: WorkflowState.now(),
          summary: "All required workflow artifacts are present.",
        }
      }

      return {
        ok: false,
        checked_at: WorkflowState.now(),
        summary: `Invalid workflow artifact structure: ${structureMissing.join(", ")}`,
        files: structureMissing,
      }
    })

    const hashApprovedArtifacts = Effect.fn("WorkflowArtifact.hashApprovedArtifacts")(function* (
      directory: string,
      workflowID: string,
    ) {
      const hash = createHash("sha256")
      for (const file of ["SPEC.md", "TASKS.md", "IMPACT.md"] as const) {
        hash.update(file)
        hash.update("\0")
        hash.update(normalizeApprovedArtifact(file, yield* readArtifact(directory, workflowID, file)))
        hash.update("\0")
      }
      return hash.digest("hex")
    })

    const writeInitialArtifacts = Effect.fn("WorkflowArtifact.writeInitialArtifacts")(function* (
      directory: string,
      state: WorkflowStateFile,
    ) {
      const dir = workflowDir(directory, state.workflow_id)
      yield* Effect.promise(() => mkdir(dir, { recursive: true }))
      yield* Effect.all(
        [
          Effect.promise(() =>
            Bun.write(
              artifactPath(directory, state.workflow_id, "SPEC.md"),
              `# ${state.title}

## Summary

Requested workflow: ${state.request ?? state.title}

## Goals

- Define the requested behavior.

## Non-Goals

- Changes not approved by this workflow plan.

## Current Behavior

- Document the current behavior before implementation.

## Proposed Behavior

- Document the proposed behavior after implementation.

## Architecture

- Document the services, modules, and integration points involved.

## Expected Files

- List files expected to change.

## Data Model Changes

- None identified.

## CLI/TUI Changes

- None identified.

## GitHub PR Flow

- Plan PR approval is required before implementation starts.
- Code PR approval is required before completion.

## Test Plan

- Add targeted validation commands for each task.

## Rollback Plan

- Revert the code PR and preserve workflow artifacts for audit.

## Open Questions

- None.
`,
            ),
          ),
          Effect.promise(() =>
            Bun.write(
              artifactPath(directory, state.workflow_id, "TASKS.md"),
              `# Tasks

- [ ] task_001 | Complete reviewed specification | files: ${relativeArtifactDir(state.workflow_id)}/SPEC.md | validation: bun typecheck | status: pending | evidence: none | github: none
- [ ] task_002 | Validate impact boundary | files: ${relativeArtifactDir(state.workflow_id)}/IMPACT.md | validation: bun typecheck | status: pending | evidence: none | github: none
- [ ] task_003 | Submit plan pull request | files: ${relativeArtifactDir(state.workflow_id)}/GITHUB.md | validation: opencode workflow status ${state.workflow_id} | status: pending | evidence: none | github: none
`,
            ),
          ),
          Effect.promise(() =>
            Bun.write(
              artifactPath(directory, state.workflow_id, "IMPACT.md"),
              `# Impact

## Allowed Paths

- .opencode/workflows/${state.workflow_id}/**

## Expected New Files

- None identified.

## Forbidden Paths

- .env
- secrets/**
- private/**

## Dependency Changes

- None approved.

## Data Model Changes

- None approved.

## Security Considerations

- Do not read, write, or expose secrets.

## Migration Risk

- None identified.

## User-Visible Changes

- None identified.

## Review Response Boundaries

Changes outside the approved impact boundary require amendment approval.

## Rollback Notes

Revert the implementation PR and leave workflow artifacts in place.
`,
            ),
          ),
          Effect.promise(() =>
            Bun.write(
              artifactPath(directory, state.workflow_id, "GITHUB.md"),
              `# GitHub\n\nPlan review state: ${state.plan_pull_request.review_state}\n\nCode review state: ${state.code_pull_request.review_state}\n\n## Open Comments\n\nNone recorded.\n\n## Addressed Comments\n\nNone recorded.\n\n## Out-of-Scope Comments\n\nNone recorded.\n\n## Review Response Log\n\nNo responses recorded.\n`,
            ),
          ),
          writeState(directory, state),
          Effect.promise(() =>
            Bun.write(
              artifactPath(directory, state.workflow_id, "DECISIONS.md"),
              `# Decisions\n\n## ${state.created_at} - workflow.created\n\nWorkflow: ${state.workflow_id}\nActor: opencode\nNew state: ${state.state}\n\nCreated workflow artifacts for ${state.workflow_id}.\n`,
            ),
          ),
        ],
        { concurrency: "unbounded" },
      )
    })

    const appendDecision = Effect.fn("WorkflowArtifact.appendDecision")(function* (
      directory: string,
      workflowID: string,
      input: DecisionInput,
    ) {
      const lines = [
        "",
        `## ${WorkflowState.now()} - ${input.action}`,
        "",
        `Workflow: ${workflowID}`,
        input.session_id ? `Session: ${input.session_id}` : undefined,
        `Actor: ${input.actor ?? "opencode"}`,
        input.previous_state ? `Previous state: ${input.previous_state}` : undefined,
        input.new_state ? `New state: ${input.new_state}` : undefined,
        input.pull_request ? `Pull request: #${input.pull_request}` : undefined,
        input.github_comment_url ? `GitHub comment: ${input.github_comment_url}` : undefined,
        input.evidence ? `Evidence: ${input.evidence}` : undefined,
        "",
        input.summary,
        "",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n")

      yield* Effect.promise(() =>
        appendFile(artifactPath(directory, workflowID, "DECISIONS.md"), lines),
      )
    })

    const writeGithubSummary = Effect.fn("WorkflowArtifact.writeGithubSummary")(function* (
      directory: string,
      state: WorkflowStateFile,
    ) {
      const formatComment = (pullRequest: "plan" | "code", comment: WorkflowState.ReviewComment) =>
        [
          `- ${pullRequest} ${comment.id} [${comment.state}] ${comment.url ?? "no-url"}`,
          `  author: ${comment.author ?? "unknown"}`,
          comment.path ? `  path: ${comment.path}${comment.line ? `:${comment.line}` : ""}` : undefined,
          `  body: ${comment.body.replace(/\s+/g, " ").slice(0, 240)}`,
        ].filter((line): line is string => line !== undefined).join("\n")
      const comments = [
        ...state.plan_pull_request.comments.map((comment) => ({ pullRequest: "plan" as const, comment })),
        ...state.code_pull_request.comments.map((comment) => ({ pullRequest: "code" as const, comment })),
      ]
      const openComments = comments.filter((item) => item.comment.state === "open")
      const addressedComments = comments.filter((item) => item.comment.state === "addressed")
      const outOfScopeComments = comments.filter((item) => item.comment.state === "out_of_scope")
      const responseSessions = state.sessions.filter((session) => session.github_comment_url)
      yield* writeArtifact(
        directory,
        state.workflow_id,
        "GITHUB.md",
        [
          "# GitHub",
          "",
          `Plan branch: ${state.plan_branch}`,
          `Plan review state: ${state.plan_pull_request.review_state}`,
          state.plan_pull_request.number
            ? `Plan pull request: #${state.plan_pull_request.number}`
            : "Plan pull request: none",
          state.plan_pull_request.url ? `Plan URL: ${state.plan_pull_request.url}` : undefined,
          state.plan_pull_request.head_commit ? `Plan head commit: ${state.plan_pull_request.head_commit}` : undefined,
          state.plan_pull_request.reviewers?.length
            ? `Plan reviewers: ${state.plan_pull_request.reviewers.join(", ")}`
            : undefined,
          state.plan_pull_request.latest_review_at
            ? `Plan latest review: ${state.plan_pull_request.latest_review_at}`
            : undefined,
          state.plan_pull_request.approved_by ? `Plan approved by: ${state.plan_pull_request.approved_by}` : undefined,
          state.plan_pull_request.approved_at ? `Plan approved at: ${state.plan_pull_request.approved_at}` : undefined,
          state.plan_approval ? `Plan approval evidence: ${state.plan_approval.github_review_evidence ?? state.plan_approval.approved_spec_hash}` : undefined,
          state.plan_approval?.approved_scope_summary ? `Approved scope: ${state.plan_approval.approved_scope_summary}` : undefined,
          "",
          `Code branch: ${state.code_branch ?? "none"}`,
          `Code review state: ${state.code_pull_request.review_state}`,
          state.code_pull_request.number
            ? `Code pull request: #${state.code_pull_request.number}`
            : "Code pull request: none",
          state.code_pull_request.url ? `Code URL: ${state.code_pull_request.url}` : undefined,
          state.code_pull_request.head_commit ? `Code head commit: ${state.code_pull_request.head_commit}` : undefined,
          state.code_pull_request.reviewers?.length
            ? `Code reviewers: ${state.code_pull_request.reviewers.join(", ")}`
            : undefined,
          state.code_pull_request.latest_review_at
            ? `Code latest review: ${state.code_pull_request.latest_review_at}`
            : undefined,
          state.code_pull_request.approved_by ? `Code approved by: ${state.code_pull_request.approved_by}` : undefined,
          state.code_pull_request.approved_at ? `Code approved at: ${state.code_pull_request.approved_at}` : undefined,
          state.code_approval ? `Code approval evidence: ${state.code_approval.github_review_evidence ?? state.code_approval.code_head_commit}` : undefined,
          state.code_approval?.validation_evidence ? `Validation evidence: ${state.code_approval.validation_evidence}` : undefined,
          "",
          `Open comments: ${WorkflowState.openComments(state).length}`,
          "",
          "## Open Comments",
          "",
          openComments.length > 0
            ? openComments.map((item) => formatComment(item.pullRequest, item.comment)).join("\n")
            : "None recorded.",
          "",
          "## Addressed Comments",
          "",
          addressedComments.length > 0
            ? addressedComments.map((item) => formatComment(item.pullRequest, item.comment)).join("\n")
            : "None recorded.",
          "",
          "## Out-of-Scope Comments",
          "",
          outOfScopeComments.length > 0
            ? outOfScopeComments.map((item) => formatComment(item.pullRequest, item.comment)).join("\n")
            : "None recorded.",
          "",
          "## Review Response Log",
          "",
          responseSessions.length > 0
            ? responseSessions.map((session) => `- ${session.updated_at} ${session.role} ${session.id} [${session.status}] ${session.github_comment_url}: ${session.task}`).join("\n")
            : "No responses recorded.",
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n"),
      )
    })

    const readAllowedPaths = Effect.fn("WorkflowArtifact.readAllowedPaths")(function* (
      directory: string,
      workflowID: string,
    ) {
      return parseImpactAllowedPaths(yield* readArtifact(directory, workflowID, "IMPACT.md"))
    })

    const validateScopeDrift = Effect.fn("WorkflowArtifact.validateScopeDrift")(function* (
      directory: string,
      workflowID: string,
      files: readonly string[],
    ) {
      return validateAllowedFiles(yield* readAllowedPaths(directory, workflowID), files)
    })

    return Service.of({
      readState,
      readArtifact,
      writeArtifact,
      writeState,
      list,
      readAll,
      validateRequired,
      hashApprovedArtifacts,
      writeInitialArtifacts,
      appendDecision,
      writeGithubSummary,
      readAllowedPaths,
      validateScopeDrift,
    })
  }),
)

export const defaultLayer = layer

export * as WorkflowArtifact from "./artifact"

// Backward-compatible async wrappers for consumers not yet on Effect
import { makeRuntime } from "@/effect/run-service"
const { runPromise } = makeRuntime(Service, layer)

export async function readState(directory: string, workflowID: string) {
  return runPromise((svc) => svc.readState(directory, workflowID))
}

export async function readArtifact(directory: string, workflowID: string, file: ArtifactFile) {
  return runPromise((svc) => svc.readArtifact(directory, workflowID, file))
}

export async function writeArtifact(directory: string, workflowID: string, file: ArtifactFile, content: string) {
  return runPromise((svc) => svc.writeArtifact(directory, workflowID, file, content))
}

export async function writeState(directory: string, state: WorkflowStateFile) {
  return runPromise((svc) => svc.writeState(directory, state))
}

export async function writeInitialArtifacts(directory: string, state: WorkflowStateFile) {
  return runPromise((svc) => svc.writeInitialArtifacts(directory, state))
}

export async function appendDecision(directory: string, workflowID: string, input: DecisionInput) {
  return runPromise((svc) => svc.appendDecision(directory, workflowID, input))
}

export async function writeGithubSummary(directory: string, state: WorkflowStateFile) {
  return runPromise((svc) => svc.writeGithubSummary(directory, state))
}

export async function hashApprovedArtifacts(directory: string, workflowID: string) {
  return runPromise((svc) => svc.hashApprovedArtifacts(directory, workflowID))
}

export async function validateRequired(directory: string, workflowID: string) {
  return runPromise((svc) => svc.validateRequired(directory, workflowID))
}

export async function validateScopeDrift(directory: string, workflowID: string, files: readonly string[]) {
  return runPromise((svc) => svc.validateScopeDrift(directory, workflowID, files))
}

export async function readAllowedPaths(directory: string, workflowID: string) {
  return runPromise((svc) => svc.readAllowedPaths(directory, workflowID))
}

export async function list(directory: string) {
  return runPromise((svc) => svc.list(directory))
}

export async function readAll(directory: string) {
  return runPromise((svc) => svc.readAll(directory))
}
