import { AppProcess } from "@opencode-ai/core/process"
import type { Argv } from "yargs"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { EOL } from "os"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { Git, type Item as GitItem } from "@/git"
import { Memory } from "@/memory"
import { MemoryGithub } from "@/memory/github"
import { parseGitHubRemote, parseRepositoryReference } from "@/util/repository"
import { Config } from "@/config/config"

interface QueryArgs {
  readonly text: string
  readonly file?: string
  readonly json?: boolean
}

interface GithubIndexArgs {
  readonly repo?: string
  readonly since?: string
  readonly limit?: number
  readonly reset?: boolean
}

interface GithubProviderConfig {
  readonly include_authors?: readonly string[]
  readonly exclude_authors?: readonly string[]
  readonly max_age_days?: number
}

interface ReviewArgs {
  readonly base?: string
  readonly pr?: number
  readonly json?: boolean
}

const githubIndexThrottleMs = 1_000

export interface ReviewChange {
  readonly file: string
  readonly status: GitItem["status"]
}

export interface ReviewReport {
  readonly repo?: string
  readonly base?: string
  readonly pr?: number
  readonly changes: readonly ReviewChange[]
  readonly results: readonly Memory.QueryResult[]
}

export const MemoryCommand = cmd({
  command: "memory",
  describe: "manage memory",
  builder: (yargs: Argv) =>
    yargs.command(MemoryIndexCommand).command(MemoryQueryCommand).command(MemoryReviewCommand).demandCommand(),
  handler() {},
})

export const MemoryIndexCommand = cmd({
  command: "index",
  describe: "index memory",
  builder: (yargs: Argv) => yargs.command(MemoryIndexGithubCommand).demandCommand(),
  handler() {},
})

export const MemoryIndexGithubCommand = effectCmd({
  command: "github",
  describe: "index GitHub PR review comments",
  builder: (yargs) =>
    yargs
      .option("repo", {
        describe: "GitHub repository in owner/repo form",
        type: "string",
      })
      .option("since", {
        describe: "only fetch comments updated after this date",
        type: "string",
      })
      .option("limit", {
        describe: "maximum number of comments to fetch",
        type: "number",
      })
      .option("reset", {
        describe: "clear indexed GitHub memory for this repository without fetching",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.memory.index.github")(function* (args) {
    const validation = validateGithubIndexArgs(args)
    if (validation) return yield* fail(validation)

    const repo = yield* resolveGithubRepo(args.repo)
    const cfg = yield* Config.Service.use((config) => config.get())
    const result = yield* MemoryGithub.index(
      toGithubIndexInput(args, repo, cfg.memory?.providers?.github, (progress) => {
        console.log(formatGithubIndexProgress(progress))
      }),
    ).pipe(
      Effect.provide(AppProcess.defaultLayer),
      Effect.catchTag("GithubMemoryIndexError", (error) => fail(error.message)),
    )
    console.log(args.reset ? formatGithubResetText(repo) : formatGithubIndexText(result))
  }),
})

export const MemoryQueryCommand = effectCmd({
  command: "query <text>",
  describe: "query memory",
  builder: (yargs) =>
    yargs
      .positional("text", {
        describe: "query text",
        type: "string",
        demandOption: true,
      })
      .option("file", {
        describe: "limit results to a file path",
        type: "string",
      })
      .option("json", {
        describe: "print results as JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.memory.query")(function* (args) {
    const results = yield* Memory.Service.use((memory) => memory.query(toQueryInput(args)))
    console.log(args.json ? formatQueryJSON(results) : formatQueryText(results))
  }),
})

export const MemoryReviewCommand = effectCmd({
  command: "review",
  describe: "show review memories relevant to the current diff",
  builder: (yargs) =>
    yargs
      .option("base", {
        describe: "base branch or ref to compare against",
        type: "string",
        default: "dev",
      })
      .option("pr", {
        describe: "GitHub pull request number to review",
        type: "number",
      })
      .option("json", {
        describe: "print results as JSON",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.memory.review")(function* (args) {
    const validation = validateReviewArgs(args)
    if (validation) return yield* fail(validation)

    const repo = yield* resolveReviewRepo()
    const changes = args.pr
      ? yield* loadPrReviewChanges(args.pr, repo)
      : yield* loadBaseReviewChanges(args.base ?? "dev")
    const memory = yield* Memory.Service
    const results = yield* queryReviewMemory(memory, repo, changes)
    const report = {
      ...(repo ? { repo } : {}),
      ...(args.pr ? { pr: args.pr } : { base: args.base ?? "dev" }),
      changes,
      results,
    } satisfies ReviewReport

    console.log(args.json ? formatReviewJSON(report) : formatReviewText(report))
  }),
})

export function toQueryInput(args: QueryArgs): Memory.QueryInput {
  if (!args.file) return { text: args.text }
  return { text: args.text, file: args.file }
}

export function validateGithubIndexArgs(args: GithubIndexArgs) {
  if (args.since && Number.isNaN(Date.parse(args.since))) return "--since must be a valid date"
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit <= 0)) {
    return "--limit must be a positive integer"
  }
}

export function validateReviewArgs(args: ReviewArgs) {
  if (args.base !== undefined && args.base.trim() === "") return "--base must not be empty"
  if (args.pr !== undefined && (!Number.isInteger(args.pr) || args.pr <= 0)) return "--pr must be a positive integer"
}

export function toGithubIndexInput(
  args: GithubIndexArgs,
  repo: string,
  githubConfig?: GithubProviderConfig,
  onProgress?: (progress: MemoryGithub.IndexProgress) => void,
): MemoryGithub.IndexInput {
  return {
    repo,
    since: args.since,
    limit: args.limit,
    ...(args.reset ? { reset: true } : {}),
    throttle_ms: githubIndexThrottleMs,
    ...(onProgress ? { onProgress } : {}),
    include_authors: githubConfig?.include_authors,
    exclude_authors: githubConfig?.exclude_authors,
    max_age_days: githubConfig?.max_age_days,
  }
}

export function parseGithubIndexRepo(input: string) {
  const parsed = parseRepositoryReference(input)
  if (!parsed || parsed.host !== "github.com" || !parsed.owner || parsed.segments.length !== 2) return
  return `${parsed.owner}/${parsed.repo}`
}

export function formatQueryJSON(results: readonly Memory.QueryResult[]) {
  return JSON.stringify(results.map(publicQueryResult), null, 2)
}

export function toReviewQueryInput(input: { readonly repo?: string; readonly changes: readonly ReviewChange[] }) {
  return {
    text: reviewQueryText(input.changes),
    ...(input.repo ? { repo: input.repo } : {}),
    limit: 50,
  } satisfies Memory.QueryInput
}

export function formatReviewJSON(report: ReviewReport) {
  return JSON.stringify(
    {
      ...(report.repo ? { repo: report.repo } : {}),
      ...(report.base ? { base: report.base } : {}),
      ...(report.pr ? { pr: report.pr } : {}),
      files: report.changes.map((change) => change.file),
      changes: report.changes,
      results: report.results.map(publicReviewResult),
    },
    null,
    2,
  )
}

export function formatReviewText(report: ReviewReport) {
  const header = [
    `Review memory checklist for ${report.repo ?? "current repository"}`,
    report.pr ? `Scope: PR #${report.pr}` : `Scope: diff against ${report.base ?? "dev"}`,
    `Changed files: ${report.changes.length}`,
  ]

  if (report.changes.length === 0) return [...header, "", "No changed files found."].join(EOL)
  if (report.results.length === 0) return [...header, "", "No review memories found."].join(EOL)

  return [
    header.join(EOL),
    ...report.results.map((result, index) =>
      [
        `${index + 1}. [ ] ${result.body}`,
        result.files?.length
          ? `   files: ${result.files.join(", ")}`
          : result.file
            ? `   file: ${result.file}`
            : undefined,
        reviewPrState(result.metadata),
        result.confidence === undefined ? undefined : `   confidence: ${result.confidence}`,
        result.citations?.length
          ? `   citations: ${result.citations.map((citation) => `${citation.label} ${citation.url}`).join(", ")}`
          : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join(EOL),
    ),
  ].join(EOL + EOL)
}

export function rankReviewResults(
  results: readonly Memory.QueryResult[],
  changes: readonly ReviewChange[],
): Memory.QueryResult[] {
  return [...results]
    .sort((a, b) => {
      const rankA = reviewRank(a, changes)
      const rankB = reviewRank(b, changes)
      return (
        rankB.exact - rankA.exact ||
        rankB.directory - rankA.directory ||
        rankB.prState - rankA.prState ||
        rankB.shape - rankA.shape ||
        b.score - a.score ||
        a.id.localeCompare(b.id)
      )
    })
    .slice(0, 20)
}

export function parsePrReviewChanges(input: string) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [file, status] = line.split("\t")
      if (!file) return []
      return [{ file, status: reviewStatus(status) } satisfies ReviewChange]
    })
}

export function formatGithubIndexText(result: MemoryGithub.IndexResult) {
  const lines = [`Indexed ${result.indexed} of ${result.fetched} GitHub review comments for ${result.repo}.`]
  if (result.cursor) lines.push(`Checkpoint: ${result.cursor}`)
  return lines.join(EOL)
}

export function formatGithubResetText(repo: string) {
  return `Cleared indexed GitHub memory for ${repo}.`
}

export function formatGithubIndexProgress(progress: MemoryGithub.IndexProgress) {
  if (progress.type === "comments") {
    return [
      `Fetched ${progress.fetched} GitHub review comments from page ${progress.page}`,
      `(${progress.total}${progress.limit === undefined ? " total" : `/${progress.limit}`}).`,
    ].join(" ")
  }
  return `Fetched GitHub PR metadata ${progress.current}/${progress.total} (#${progress.number}).`
}

export function formatQueryText(results: readonly Memory.QueryResult[]) {
  if (results.length === 0) return "No memories found."

  return results
    .map((result, index) =>
      [
        `${index + 1}. ${result.title}`,
        result.file ? `   file: ${result.file}` : undefined,
        `   score: ${result.score}`,
        `   ${result.body}`,
      ]
        .filter((line): line is string => line !== undefined)
        .join(EOL),
    )
    .join(EOL + EOL)
}

function queryReviewMemory(memory: Memory.Interface, repo: string | undefined, changes: readonly ReviewChange[]) {
  return Effect.gen(function* () {
    if (changes.length === 0) return []

    const general = yield* memory.query(toReviewQueryInput({ repo, changes }))
    const exact = yield* Effect.all(
      changes.map((change) =>
        memory.query({
          text: change.file,
          file: change.file,
          ...(repo ? { repo } : {}),
          limit: 10,
        }),
      ),
      { concurrency: 4 },
    )

    return rankReviewResults(uniqueResults([...exact.flat(), ...general]), changes)
  })
}

function loadBaseReviewChanges(base: string) {
  return Effect.gen(function* () {
    const ctx = yield* requireGitContext()
    const git = yield* Git.Service
    const ref = (yield* git.mergeBase(ctx.worktree, base)) ?? base
    const diff = yield* git.diff(ctx.worktree, ref)
    const untracked = (yield* git.status(ctx.worktree)).filter((item) => item.code === "??")
    return toReviewChanges([...diff, ...untracked])
  })
}

function loadPrReviewChanges(pr: number, repo: string | undefined) {
  return Effect.gen(function* () {
    if (!repo) return yield* fail("Could not read GitHub origin remote for --pr review.")

    const ctx = yield* requireGitContext()
    const appProcess = yield* AppProcess.Service
    const result = yield* appProcess
      .run(
        ChildProcess.make(
          "gh",
          ["api", `repos/${repo}/pulls/${pr}/files`, "--paginate", "--jq", ".[] | [.filename, .status] | @tsv"],
          {
            cwd: ctx.worktree,
            extendEnv: true,
            stdin: "ignore",
          },
        ),
        { maxOutputBytes: 1024 * 1024, maxErrorBytes: 64 * 1024 },
      )
      .pipe(Effect.catch((error) => fail(`Failed to read PR #${pr} files: ${String(error)}`)))

    if (result.exitCode !== 0) {
      return yield* fail(`Failed to read PR #${pr} files: ${result.stderr.toString("utf8").trim()}`)
    }

    return parsePrReviewChanges(result.stdout.toString("utf8"))
  }).pipe(Effect.provide(AppProcess.defaultLayer))
}

function resolveReviewRepo() {
  return Effect.gen(function* () {
    const ctx = yield* requireGitContext()
    const result = yield* Git.Service.use((git) => git.run(["remote", "get-url", "origin"], { cwd: ctx.worktree }))
    if (result.exitCode !== 0) return

    const parsed = parseGitHubRemote(result.text().trim())
    if (!parsed) return
    return `${parsed.owner}/${parsed.repo}`
  })
}

function requireGitContext() {
  return Effect.gen(function* () {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* fail("Could not load instance context")
    if (ctx.project.vcs !== "git") {
      return yield* fail("Could not find git repository. Please run this command from a git repository.")
    }
    return ctx
  })
}

function toReviewChanges(items: readonly GitItem[]) {
  return [
    ...new Map(
      items.map((item) => [item.file, { file: item.file, status: item.status } satisfies ReviewChange]),
    ).values(),
  ]
}

function uniqueResults(results: readonly Memory.QueryResult[]) {
  return [...new Map(results.map((result) => [result.id, result])).values()]
}

function reviewQueryText(changes: readonly ReviewChange[]) {
  return changes.flatMap((change) => [change.file, directory(change.file), change.status]).join(" ")
}

function reviewRank(result: Memory.QueryResult, changes: readonly ReviewChange[]) {
  const resultFiles = [result.file, ...(result.files ?? [])].filter((file): file is string => file !== undefined)
  const exact = changes.filter((change) => resultFiles.includes(change.file)).length
  const resultDirs = new Set(resultFiles.map(directory))
  const directoryOverlap = changes.filter((change) => resultDirs.has(directory(change.file))).length
  const searchable = `${result.title} ${result.body}`.toLowerCase()
  const shape = changes.filter((change) => searchable.includes(change.status)).length
  return {
    exact,
    directory: directoryOverlap,
    prState: prStateWeight(result.metadata),
    shape,
  }
}

function prStateWeight(metadata: Record<string, unknown> | undefined) {
  const pr = metadata?.pr
  if (!pr || typeof pr !== "object") return 0
  if (!("state" in pr) || pr.state !== "closed") return 0
  if (!("merged" in pr)) return 0
  if (pr.merged === true) return 30
  if (pr.merged === false) return 15
  return 0
}

function publicQueryResult(result: Memory.QueryResult): Memory.QueryResult {
  const { metadata: _, ...rest } = result
  return rest
}

function publicReviewResult(result: Memory.QueryResult): Memory.QueryResult {
  const metadata = publicReviewMetadata(result.metadata)
  if (!metadata) return publicQueryResult(result)
  return { ...publicQueryResult(result), metadata }
}

function publicReviewMetadata(metadata: Record<string, unknown> | undefined) {
  const pr = publicReviewPr(metadata)
  const commits = publicReviewCommits(metadata)
  if (!pr && !commits) return
  return {
    ...(pr ? { pr } : {}),
    ...(commits ? { commits } : {}),
  }
}

function reviewPrState(metadata: Record<string, unknown> | undefined) {
  const pr = publicReviewPr(metadata)
  if (!pr) return
  return `   PR #${pr.number} ${pr.state === "closed" && pr.merged ? "merged" : pr.state}`
}

function publicReviewPr(metadata: Record<string, unknown> | undefined) {
  const pr = metadata?.pr
  if (!pr || typeof pr !== "object") return
  if (!("number" in pr) || typeof pr.number !== "number") return
  if (!("state" in pr) || (pr.state !== "open" && pr.state !== "closed")) return
  if (!("merged" in pr) || typeof pr.merged !== "boolean") return
  return {
    number: pr.number,
    state: pr.state,
    merged: pr.merged,
    ...("closed_at" in pr && typeof pr.closed_at === "string" ? { closed_at: pr.closed_at } : {}),
    ...("merged_at" in pr && typeof pr.merged_at === "string" ? { merged_at: pr.merged_at } : {}),
    ...("title" in pr && typeof pr.title === "string" ? { title: pr.title } : {}),
  }
}

function publicReviewCommits(metadata: Record<string, unknown> | undefined) {
  if (!Array.isArray(metadata?.commits)) return
  const commits = metadata.commits.flatMap((commit) => {
    if (!commit || typeof commit !== "object") return []
    if (!("sha" in commit) || typeof commit.sha !== "string") return []
    if (!("message" in commit) || typeof commit.message !== "string") return []
    return [{ sha: commit.sha, message: commit.message }]
  })
  if (commits.length === 0) return
  return commits
}

function reviewStatus(input: string | undefined): ReviewChange["status"] {
  if (input === "added") return "added"
  if (input === "removed") return "deleted"
  return "modified"
}

function directory(file: string) {
  if (!file.includes("/")) return "."
  return file.split("/").slice(0, -1).join("/")
}

function resolveGithubRepo(input: string | undefined) {
  return Effect.gen(function* () {
    if (input) {
      const repo = parseGithubIndexRepo(input)
      if (!repo) return yield* fail("--repo must be a GitHub owner/repo repository")
      return repo
    }

    const ctx = yield* InstanceRef
    if (!ctx) return yield* fail("Could not load instance context")
    if (ctx.project.vcs !== "git") {
      return yield* fail("Could not find git repository. Please run this command from a git repository.")
    }

    const result = yield* Git.Service.use((git) => git.run(["remote", "get-url", "origin"], { cwd: ctx.worktree }))
    if (result.exitCode !== 0) return yield* fail("Could not read git origin remote. Use --repo owner/repo.")

    const parsed = parseGitHubRemote(result.text().trim())
    if (!parsed) return yield* fail("Git origin remote is not a GitHub repository. Use --repo owner/repo.")
    return `${parsed.owner}/${parsed.repo}`
  })
}
