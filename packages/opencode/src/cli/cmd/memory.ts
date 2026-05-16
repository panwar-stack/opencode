import { AppProcess } from "@opencode-ai/core/process"
import type { Argv } from "yargs"
import { Effect } from "effect"
import { EOL } from "os"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { Git } from "@/git"
import { Memory } from "@/memory"
import { MemoryGithub } from "@/memory/github"
import { parseGitHubRemote, parseRepositoryReference } from "@/util/repository"

interface QueryArgs {
  readonly text: string
  readonly file?: string
  readonly json?: boolean
}

interface GithubIndexArgs {
  readonly repo?: string
  readonly since?: string
  readonly limit?: number
}

export const MemoryCommand = cmd({
  command: "memory",
  describe: "manage memory",
  builder: (yargs: Argv) => yargs.command(MemoryIndexCommand).command(MemoryQueryCommand).demandCommand(),
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
      }),
  handler: Effect.fn("Cli.memory.index.github")(function* (args) {
    const validation = validateGithubIndexArgs(args)
    if (validation) return yield* fail(validation)

    const repo = yield* resolveGithubRepo(args.repo)
    const result = yield* MemoryGithub.index(toGithubIndexInput(args, repo)).pipe(
      Effect.provide(AppProcess.defaultLayer),
      Effect.catchTag("GithubMemoryIndexError", (error) => fail(error.message)),
    )
    console.log(formatGithubIndexText(result))
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

export function toGithubIndexInput(args: GithubIndexArgs, repo: string): MemoryGithub.IndexInput {
  return {
    repo,
    since: args.since,
    limit: args.limit,
  }
}

export function parseGithubIndexRepo(input: string) {
  const parsed = parseRepositoryReference(input)
  if (!parsed || parsed.host !== "github.com" || !parsed.owner || parsed.segments.length !== 2) return
  return `${parsed.owner}/${parsed.repo}`
}

export function formatQueryJSON(results: readonly Memory.QueryResult[]) {
  return JSON.stringify(results, null, 2)
}

export function formatGithubIndexText(result: MemoryGithub.IndexResult) {
  const lines = [`Indexed ${result.indexed} of ${result.fetched} GitHub review comments for ${result.repo}.`]
  if (result.cursor) lines.push(`Checkpoint: ${result.cursor}`)
  return lines.join(EOL)
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
