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
  parseSpecContent: (spec: string) => Effect.Effect<SpecContent>
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
        const body = comment.body.toLowerCase()

        for (const item of spec.out_of_scope) {
          const keywords = item.toLowerCase().split(/\s+/).filter((w) => w.length >= 2)
          if (body.includes(item.toLowerCase()) || keywords.some((kw) => body.includes(kw))) {
            return {
              tag: "out_of_scope" as const,
              reason: `Comment references out-of-scope item: ${item}`,
            }
          }
        }

        const relevantReq = spec.requirements.find((req) => body.includes(req.toLowerCase()))
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

        return {
          tag: "out_of_scope" as const,
          reason: "Comment does not map to a recognized requirement or out-of-scope item.",
        }
      },
    )

    const parseSpecContentFn = Effect.fn("WorkflowScope.parseSpecContent")(function* (spec: string) {
      return parseSpecContent(spec)
    })

    return Service.of({
      checkEdit,
      checkComment,
      parseSpecContent: parseSpecContentFn,
    })
  }),
)

export const defaultLayer = layer

export * as WorkflowScope from "./scope"
