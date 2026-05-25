import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Memory } from "@/memory/memory"
import { MemoryEval } from "@/memory/eval"

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
      })
      .option("summaries", {
        type: "number",
        default: 200,
        describe: "number of top active files to summarize; use 0 to skip summaries",
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
      summaries: args.summaries,
    })
    console.log(`Repository: ${result.repository.identity}`)
    console.log(`Worktree: ${result.worktree}`)
    console.log(`Commits indexed: ${result.indexedCommits}`)
    console.log(`Commits skipped: ${result.skippedCommits}`)
    console.log(`File activity records: ${result.fileActivity}`)
    console.log(`File summaries generated: ${result.summaries.generated}`)
    console.log(`File summaries reused: ${result.summaries.reused}`)
    console.log(`File summaries failed: ${result.summaries.failed}`)
    result.summaries.failures.slice(0, 10).forEach((failure) => console.log(`   ${failure.path}: ${failure.message}`))
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
    yield* memory.logRetrieval({
      repository_id: repository.id,
      tool: "memory_cli_search_commit",
      query: args.query,
      returned_items: results.map((result) => result.hash),
      final_files: unique(results.flatMap((result) => parseJsonArray(result.changed_files))),
    })
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

const SearchSummaryCommand = effectCmd({
  command: "summary <query>",
  describe: "search repository file summaries",
  builder: (yargs: Argv) =>
    yargs
      .positional("query", {
        type: "string",
        describe: "search query",
      })
      .option("limit", {
        type: "number",
        default: 5,
        describe: "maximum results",
      }),
  handler: Effect.fn("Cli.memory.search.summary")(function* (args) {
    const memory = yield* Memory.Service
    if (!args.query) return yield* fail("Search query is required")
    const current = yield* memory.currentRepository()
    const repository = yield* memory.getRepository(current.identity)
    if (!repository) return yield* fail(`No repository memory index found for ${current.identity}`)
    const results = yield* memory.searchSummaryRows({ repository_id: repository.id, query: args.query, limit: args.limit })
    yield* memory.logRetrieval({
      repository_id: repository.id,
      tool: "memory_cli_search_summary",
      query: args.query,
      returned_items: results.map((result) => result.path),
      final_files: results.map((result) => result.path),
    })
    console.log(`Repository: ${repository.identity}`)
    console.log(`Query: ${args.query}`)
    if (!results.length) {
      console.log("No summary matches found.")
      return
    }
    results.forEach((result, index) => {
      console.log(`${index + 1}. ${result.path} score=${result.score.toFixed(3)} strength=${result.strength}`)
      console.log(`   Summary: ${snippet(result.summary)}`)
      const symbols = parseJsonArray(result.important_symbols)
      if (symbols.length) console.log(`   Important symbols: ${symbols.join(", ")}`)
    })
  }),
})

const SearchCommand = cmd({
  command: "search",
  describe: "search repository memory",
  builder: (yargs: Argv) => yargs.command(SearchCommitCommand).command(SearchSummaryCommand).demandCommand(),
  handler: () => {},
})

const ViewSummaryCommand = effectCmd({
  command: "summary <path>",
  describe: "view a cached repository file summary",
  builder: (yargs: Argv) =>
    yargs.positional("path", {
      type: "string",
      describe: "file path",
    }),
  handler: Effect.fn("Cli.memory.view.summary")(function* (args) {
    const memory = yield* Memory.Service
    if (!args.path) return yield* fail("Summary path is required")
    const current = yield* memory.currentRepository()
    const repository = yield* memory.getRepository(current.identity)
    if (!repository) return yield* fail(`No repository memory index found for ${current.identity}`)
    const summary = yield* memory.getFileSummary({ repository_id: repository.id, path: args.path, worktree: current.worktree })
    if (!summary) return yield* fail(`File summary not found: ${args.path}`)
    yield* memory.logRetrieval({
      repository_id: repository.id,
      tool: "memory_cli_view_summary",
      query: args.path,
      returned_items: [summary.path],
      final_files: [summary.path],
    })
    console.log(`Repository: ${repository.identity}`)
    console.log(`Path: ${summary.path}`)
    console.log(`Status: ${summary.missing ? "missing" : summary.stale ? "stale" : "current"}`)
    console.log(`Model: ${summary.model_id ?? "unknown"}`)
    const symbols = parseJsonArray(summary.important_symbols)
    if (symbols.length) console.log(`Important symbols: ${symbols.join(", ")}`)
    console.log("Summary:")
    console.log(summary.summary)
  }),
})

const ViewCommand = cmd({
  command: "view",
  describe: "view repository memory",
  builder: (yargs: Argv) => yargs.command(ViewSummaryCommand).demandCommand(),
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
    yield* memory.logRetrieval({
      repository_id: repository.id,
      tool: "memory_cli_examine_commit",
      query: args.hash,
      returned_items: [commit.hash],
      final_files: parseJsonArray(commit.changed_files),
    })
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

const EvalCommand = effectCmd({
  command: "eval",
  describe: "evaluate repository memory localization against historical issues",
  builder: (yargs: Argv) =>
    yargs
      .option("issues", {
        type: "string",
        demandOption: true,
        describe: "path to historical issues JSON",
      })
      .option("max-commits", {
        type: "number",
        default: 7_000,
        describe: "maximum commits to index per issue",
      })
      .option("summaries", {
        type: "number",
        default: 200,
        describe: "number of top active files to summarize; use 0 to skip summaries",
      }),
  handler: Effect.fn("Cli.memory.eval")(function* (args) {
    const memory = yield* Memory.Service
    const result = yield* MemoryEval.run(memory, {
      issuesPath: args.issues,
      maxCommits: args["max-commits"],
      summaries: args.summaries,
    }).pipe(Effect.catch((error: Error) => fail(error.message)))
    MemoryEval.format(result).forEach((line) => console.log(line))
  }),
})

export const MemoryCommand = cmd({
  command: "memory",
  describe: "repository memory tools",
  builder: (yargs: Argv) =>
    yargs
      .command(IndexCommand)
      .command(StatusCommand)
      .command(SearchCommand)
      .command(ViewCommand)
      .command(ExamineCommand)
      .command(ClearCommand)
      .command(EvalCommand)
      .demandCommand(),
  handler: () => {},
})

function parseJsonArray(input: string) {
  const parsed = JSON.parse(input) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is string => typeof item === "string")
}

function snippet(input: string) {
  const normalized = input.replaceAll("\n", " ")
  if (normalized.length <= 180) return normalized
  return `${normalized.slice(0, 177)}...`
}

function unique(input: readonly string[]) {
  return [...new Set(input)]
}
