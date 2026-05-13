import { Context, Effect, Layer } from "effect"
import type { ReviewComment } from "./state"
import { WorkflowArtifact } from "./artifact"

export type ScopeResult = {
  readonly allowed: boolean
  readonly reason: string
  readonly offending_files?: readonly string[]
  readonly needs_amendment?: boolean
}

export type ScopeClassification =
  | { readonly tag: "in_scope"; readonly task?: string }
  | { readonly tag: "out_of_scope"; readonly reason: string }
  | { readonly tag: "clarification"; readonly question: string }

export type SpecContent = {
  readonly summary: string
  readonly requirements: readonly string[]
  readonly out_of_scope: readonly string[]
}

export type ScopeContext = SpecContent & {
  readonly allowed_paths: readonly string[]
  readonly forbidden_paths: readonly string[]
  readonly expected_files: readonly string[]
  readonly task_ids: readonly string[]
  readonly task_files: readonly string[]
  readonly amendment_rules: readonly string[]
}

function parseSection(lines: string[], header: string): readonly string[] {
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${header}\\s*$`, "i").test(line.trim()))
  if (start === -1) return []
  return lines
    .slice(start + 1)
    .filter((line, index, rest) => rest.slice(0, index).every((previous) => !/^##\s+/.test(previous.trim())))
    .map((line) => line.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((line): line is string => line !== undefined && line.length > 0)
}

function parseForbiddenPaths(impact: string): readonly string[] {
  return parseSection(impact.split(/\r?\n/), "Forbidden Paths").map((line) => line.replace(/^`|`$/g, ""))
}

function parseExpectedFiles(spec: string, impact: string) {
  return [
    ...parseSection(spec.split(/\r?\n/), "Expected Files"),
    ...parseSection(impact.split(/\r?\n/), "Expected New Files"),
  ].map((line) => line.replace(/^`|`$/g, ""))
}

function parseTaskIDs(tasks: string) {
  return tasks
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+\[[ x]\]\s+([^|\s]+)\s*\|/)?.[1]?.trim())
    .filter((line): line is string => line !== undefined && line.length > 0)
}

function parseTaskFiles(tasks: string) {
  return tasks
    .split(/\r?\n/)
    .flatMap((line) => line.match(/\|\s*files:\s*([^|]+)/i)?.[1]?.split(",") ?? [])
    .map((line) => line.trim().replace(/^`|`$/g, ""))
    .filter((line) => line.length > 0 && line.toLowerCase() !== "none")
}

function parseAmendmentRules(impact: string) {
  return [
    ...parseSection(impact.split(/\r?\n/), "Review Response Boundaries"),
    ...parseSection(impact.split(/\r?\n/), "Scope Rules"),
  ]
}

function containsMeaningfulReference(body: string, item: string) {
  const lower = item.toLowerCase()
  const keywords = lower.split(/\s+/).filter((word) => word.length >= 2)
  return body.includes(lower) || keywords.some((word) => body.includes(word))
}

function parseNewFilesAllowed(impact: string): boolean {
  const lines = impact.split(/\r?\n/)
  const start = lines.findIndex((line) => /^##\s+Scope Rules\s*$/i.test(line.trim()))
  if (start === -1) return false
  const section = lines
    .slice(start + 1)
    .filter((line, index, rest) => rest.slice(0, index).every((previous) => !/^##\s+/.test(previous.trim())))
  return section.some((line) => /new\s*files?\s*allowed/i.test(line))
}

function parseSpecContent(spec: string): SpecContent {
  const lines = spec.split(/\r?\n/)
  return {
    summary: parseSection(lines, "Summary").join(" ") || spec.slice(0, 200),
    requirements: [...parseSection(lines, "Requirements"), ...parseSection(lines, "Goals")],
    out_of_scope: [...parseSection(lines, "Out of Scope"), ...parseSection(lines, "Non-Goals")],
  }
}

export interface Interface {
  checkEdit: (projectDir: string, workflowID: string, paths: string[], existingFiles?: readonly string[]) => Effect.Effect<ScopeResult>
  checkComment: (comment: ReviewComment, spec: SpecContent) => Effect.Effect<ScopeClassification>
  classifyComment: (comment: ReviewComment, context: ScopeContext) => Effect.Effect<ScopeClassification>
  parseSpecContent: (spec: string) => Effect.Effect<SpecContent>
  readScopeContext: (projectDir: string, workflowID: string) => Effect.Effect<ScopeContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowScope") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const checkEdit = Effect.fn("WorkflowScope.checkEdit")(
      function* (projectDir: string, workflowID: string, paths: string[], existingFiles?: readonly string[]) {
        const impact = yield* Effect.promise(() => WorkflowArtifact.readArtifact(projectDir, workflowID, "IMPACT.md"))
        const allowedPaths = WorkflowArtifact.parseImpactAllowedPaths(impact)
        const forbidden = parseForbiddenPaths(impact)
        const newFilesAllowed = parseNewFilesAllowed(impact)

        for (const filePath of paths) {
          for (const forbiddenPath of forbidden) {
            if (WorkflowArtifact.matchesAllowedPath(filePath, forbiddenPath)) {
              const needsAmendment = !forbidden.some((fp) => {
                const lower = fp.toLowerCase()
                return lower.startsWith(".env") || lower.startsWith("secrets") || lower.includes("/.env") || lower.includes("credentials")
              })
              return {
                allowed: false,
                reason: `Path ${filePath} matches forbidden path ${forbiddenPath}`,
                offending_files: [filePath],
                needs_amendment: needsAmendment,
              }
            }
          }
        }

        const knownFiles = existingFiles ?? []
        for (const filePath of paths) {
          const isNew = !knownFiles.includes(filePath)
          if (isNew && !newFilesAllowed) {
            if (!allowedPaths.some((allowed) => WorkflowArtifact.matchesAllowedPath(filePath, allowed))) {
              return {
                allowed: false,
                reason: `New file ${filePath} is not in an allowed directory and new files are not allowed`,
                offending_files: [filePath],
                needs_amendment: true,
              }
            }
          }
        }

        const unknown = paths.filter(
          (filePath) => !allowedPaths.some((allowed) => WorkflowArtifact.matchesAllowedPath(filePath, allowed)),
        )

        if (unknown.length > 0) {
          return {
            allowed: false,
            reason: `Files outside approved impact boundary: ${unknown.join(", ")}`,
            offending_files: unknown,
            needs_amendment: true,
          }
        }

        return {
          allowed: true,
          reason: "All paths are within the approved impact boundary.",
        }
      },
    )

    const checkComment = Effect.fn("WorkflowScope.checkComment")(
      function* (comment: ReviewComment, spec: SpecContent) {
        return yield* classifyComment(comment, {
          ...spec,
          allowed_paths: [],
          forbidden_paths: [],
          expected_files: [],
          task_ids: [],
          task_files: [],
          amendment_rules: [],
        })
      },
    )

    const classifyComment = Effect.fn("WorkflowScope.classifyComment")(
      function* (comment: ReviewComment, context: ScopeContext) {
        const body = comment.body.toLowerCase()

        if (comment.path) {
          const forbidden = context.forbidden_paths.find((item) => WorkflowArtifact.matchesAllowedPath(comment.path ?? "", item))
          if (forbidden) {
            return {
              tag: "out_of_scope" as const,
              reason: `Comment targets forbidden path ${forbidden}`,
            }
          }
          if (context.allowed_paths.some((item) => WorkflowArtifact.matchesAllowedPath(comment.path ?? "", item))) {
            return { tag: "in_scope" as const }
          }
        }

        const task = context.task_ids.find((item) => body.includes(item.toLowerCase()))
        if (task) return { tag: "in_scope" as const, task }

        const expectedFile = [...context.expected_files, ...context.task_files].find((item) => body.includes(item.toLowerCase()))
        if (expectedFile) return { tag: "in_scope" as const, task: expectedFile }

        for (const item of context.out_of_scope) {
          if (containsMeaningfulReference(body, item)) {
            return {
              tag: "out_of_scope" as const,
              reason: `Comment references out-of-scope item: ${item}`,
            }
          }
        }

        const relevantReq = context.requirements.find((req) => body.includes(req.toLowerCase()))
        if (relevantReq) {
          return {
            tag: "in_scope" as const,
            task: relevantReq,
          }
        }

        const hasQuestion = body.includes("?") || /^(can|how|what|why|when|where|who|could|would|should|is|are|do|does)\b/i.test(body.split(/[.!?]/)[0] ?? "")
        const hasRequest = /^(please|can you|add|change|fix|remove|update|implement|refactor|rename|move|extract|create)\b/i.test(body)

        if (hasQuestion && !hasRequest) {
          return {
            tag: "clarification" as const,
            question: `Comment appears to ask for clarification: "${comment.body.slice(0, 100)}"`,
          }
        }

        if (context.amendment_rules.length > 0 && /\b(scope|outside|amend|amendment|additional|also)\b/i.test(comment.body)) {
          return {
            tag: "out_of_scope" as const,
            reason: `Comment does not map to approved tasks or files and may require amendment: ${context.amendment_rules.join(" ").slice(0, 160)}`,
          }
        }

        return {
          tag: "out_of_scope" as const,
          reason: "Comment does not map to a recognized requirement or out-of-scope item.",
        }
      },
    )

    const parseSpecContentFn = Effect.fn("WorkflowScope.parseSpecContent")(function* (spec: string) {
      return parseSpecContent(spec)
    })

    const readScopeContext = Effect.fn("WorkflowScope.readScopeContext")(function* (projectDir: string, workflowID: string) {
      const [spec, tasks, impact] = yield* Effect.all(
        [
          Effect.promise(() => WorkflowArtifact.readArtifact(projectDir, workflowID, "SPEC.md")),
          Effect.promise(() => WorkflowArtifact.readArtifact(projectDir, workflowID, "TASKS.md")),
          Effect.promise(() => WorkflowArtifact.readArtifact(projectDir, workflowID, "IMPACT.md")),
        ],
        { concurrency: 3 },
      )
      return {
        ...parseSpecContent(spec),
        allowed_paths: WorkflowArtifact.parseImpactAllowedPaths(impact),
        forbidden_paths: parseForbiddenPaths(impact),
        expected_files: parseExpectedFiles(spec, impact),
        task_ids: parseTaskIDs(tasks),
        task_files: parseTaskFiles(tasks),
        amendment_rules: parseAmendmentRules(impact),
      }
    })

    return Service.of({
      checkEdit,
      checkComment,
      classifyComment,
      parseSpecContent: parseSpecContentFn,
      readScopeContext,
    })
  }),
)

export const defaultLayer = layer

export * as WorkflowScope from "./scope"
