import { Context, Effect, Layer } from "effect"

export interface Entry {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly file?: string
}

export interface QueryInput {
  readonly text: string
  readonly file?: string
}

export interface QueryResult extends Entry {
  readonly score: number
}

export interface Interface {
  readonly query: (input: QueryInput) => Effect.Effect<QueryResult[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

export const layer = (entries: readonly Entry[] = []) =>
  Layer.succeed(
    Service,
    Service.of({
      query: Effect.fn("Memory.query")((input) => Effect.succeed(queryEntries(entries, input))),
    }),
  )

export const defaultLayer = layer()

function queryEntries(entries: readonly Entry[], input: QueryInput) {
  const terms = input.text
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/)
    .filter(Boolean)

  if (terms.length === 0) return []

  return entries
    .filter((entry) => !input.file || entry.file === input.file)
    .map((entry) => ({ ...entry, score: scoreEntry(entry, input.text.toLowerCase(), terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

function scoreEntry(entry: Entry, query: string, terms: string[]) {
  const searchable = [entry.title, entry.body, entry.file ?? ""].join("\n").toLowerCase()
  return (searchable.includes(query) ? 10 : 0) + terms.filter((term) => searchable.includes(term)).length
}

export * as Memory from "."
