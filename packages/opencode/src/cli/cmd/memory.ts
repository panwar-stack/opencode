import type { Argv } from "yargs"
import { Effect } from "effect"
import { EOL } from "os"
import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"
import { Memory } from "@/memory"

interface QueryArgs {
  readonly text: string
  readonly file?: string
  readonly json?: boolean
}

export const MemoryCommand = cmd({
  command: "memory",
  describe: "query memory",
  builder: (yargs: Argv) => yargs.command(MemoryQueryCommand).demandCommand(),
  handler() {},
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

export function formatQueryJSON(results: readonly Memory.QueryResult[]) {
  return JSON.stringify(results, null, 2)
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
