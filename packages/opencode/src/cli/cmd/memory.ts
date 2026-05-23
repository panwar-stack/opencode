import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Memory } from "@/memory/memory"

const IndexCommand = effectCmd({
  command: "index",
  describe: "index local git commits for repository memory",
  builder: (yargs: Argv) =>
    yargs
      .option("max-commits", {
        type: "number",
        default: 7_000,
        describe: "maximum commits to index",
      })
      .option("since", {
        type: "string",
        describe: "only index commits since this git date",
      })
      .option("base-commit", {
        type: "string",
        describe: "exclusive cutoff commit",
      })
      .option("cutoff-time", {
        type: "string",
        describe: "exclusive ISO cutoff timestamp",
      })
      .option("branch", {
        type: "string",
        describe: "branch or revision to index",
      })
      .option("github", {
        type: "boolean",
        default: true,
        describe: "allow GitHub enrichment (use --no-github to disable; indexing is offline-safe)",
      }),
  handler: Effect.fn("Cli.memory.index")(function* (args) {
    const memory = yield* Memory.Service
    const result = yield* memory.indexLocalRepository({
      maxCommits: args["max-commits"],
      since: args.since,
      baseCommit: args["base-commit"],
      cutoffTime: args["cutoff-time"],
      branch: args.branch,
      noGithub: args.github === false,
    })
    console.log(`Repository: ${result.repository.identity}`)
    console.log(`Worktree: ${result.worktree}`)
    console.log(`Commits indexed: ${result.indexedCommits}`)
    console.log(`Commits skipped: ${result.skippedCommits}`)
    console.log(`File activity records: ${result.fileActivity}`)
  }),
})

const StatusCommand = effectCmd({
  command: "status",
  describe: "show repository memory status",
  handler: Effect.fn("Cli.memory.status")(function* () {
    const memory = yield* Memory.Service
    const current = yield* memory.currentRepository()
    const status = yield* memory.status(current.identity)
    console.log(`Repository: ${current.identity}`)
    if (!status) {
      console.log("Commits: 0")
      console.log("File activity: 0")
      console.log("Summaries: 0")
      return
    }
    console.log(`Commits: ${status.commits}`)
    console.log(`File activity: ${status.file_activity}`)
    console.log(`Summaries: ${status.summaries}`)
  }),
})

const SearchCommitCommand = effectCmd({
  command: "commit <query>",
  describe: "search repository commit memory",
  builder: (yargs: Argv) =>
    yargs
      .positional("query", {
        type: "string",
        describe: "search query",
      })
      .option("limit", {
        type: "number",
        default: 20,
        describe: "maximum results",
      }),
  handler: Effect.fn("Cli.memory.search.commit")(function* (args) {
    const memory = yield* Memory.Service
    if (!args.query) return yield* fail("Search query is required")
    const current = yield* memory.currentRepository()
    const repository = yield* memory.getRepository(current.identity)
    if (!repository) return yield* fail(`No repository memory index found for ${current.identity}`)
    const results = yield* memory.searchCommitRows({ repository_id: repository.id, query: args.query, limit: args.limit })
    console.log(`Repository: ${repository.identity}`)
    console.log(`Query: ${args.query}`)
    if (!results.length) {
      console.log("No commit matches found.")
      return
    }
    results.forEach((result, index) => {
      console.log(`${index + 1}. ${result.hash} score=${result.score.toFixed(3)} strength=${result.strength}`)
      console.log(`   Message: ${result.message}`)
      console.log(`   Changed files: ${parseJsonArray(result.changed_files).join(", ")}`)
    })
  }),
})

const SearchCommand = cmd({
  command: "search",
  describe: "search repository memory",
  builder: (yargs: Argv) => yargs.command(SearchCommitCommand).demandCommand(),
  handler: () => {},
})

const ExamineCommitCommand = effectCmd({
  command: "commit <hash>",
  describe: "examine a repository memory commit",
  builder: (yargs: Argv) =>
    yargs
      .positional("hash", {
        type: "string",
        describe: "commit hash",
      })
      .option("max-diff-bytes", {
        type: "number",
        default: 50_000,
        describe: "maximum diff bytes to print",
      }),
  handler: Effect.fn("Cli.memory.examine.commit")(function* (args) {
    const memory = yield* Memory.Service
    if (!args.hash) return yield* fail("Commit hash is required")
    const current = yield* memory.currentRepository()
    const repository = yield* memory.getRepository(current.identity)
    if (!repository) return yield* fail(`No repository memory index found for ${current.identity}`)
    const commit = yield* memory.getCommit({ repository_id: repository.id, hash: args.hash }).pipe(
      Effect.catch((error: Error) => fail(error.message)),
    )
    if (!commit) return yield* fail(`Commit memory not found: ${args.hash}`)
    const maxDiffBytes = args["max-diff-bytes"]
    const diff = commit.diff.slice(0, maxDiffBytes)
    console.log("Warning: this is historical memory. Verify against the current working tree before editing.")
    console.log(`Repository: ${repository.identity}`)
    console.log(`Commit: ${commit.hash}`)
    console.log(`Message: ${commit.message}`)
    console.log(`Changed files: ${parseJsonArray(commit.changed_files).join(", ")}`)
    console.log("Diff:")
    console.log(diff)
    if (diff.length < commit.diff.length) console.log(`[diff truncated to ${maxDiffBytes} bytes]`)
  }),
})

const ExamineCommand = cmd({
  command: "examine",
  describe: "examine repository memory",
  builder: (yargs: Argv) => yargs.command(ExamineCommitCommand).demandCommand(),
  handler: () => {},
})

const ClearCommand = effectCmd({
  command: "clear",
  describe: "clear repository memory",
  builder: (yargs: Argv) =>
    yargs.option("repository", {
      type: "string",
      describe: "repository identity to clear",
    }),
  handler: Effect.fn("Cli.memory.clear")(function* (args) {
    const memory = yield* Memory.Service
    const repository = args.repository ?? (yield* memory.currentRepository()).identity
    const cleared = yield* memory.clearRepository(repository)
    console.log(`Repository: ${repository}`)
    console.log(cleared ? "Cleared: yes" : "Cleared: no index found")
  }),
})

export const MemoryCommand = cmd({
  command: "memory",
  describe: "repository memory tools",
  builder: (yargs: Argv) =>
    yargs.command(IndexCommand).command(StatusCommand).command(SearchCommand).command(ExamineCommand).command(ClearCommand).demandCommand(),
  handler: () => {},
})

function parseJsonArray(input: string) {
  const parsed = JSON.parse(input) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is string => typeof item === "string")
}
