import { Context, Effect, Layer } from "effect"
import { MemoryIndex } from "./repo"
import { queryEntries } from "./search"

export interface Citation {
  readonly label: string
  readonly url: string
}

export interface Entry {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly file?: string
  readonly files?: readonly string[]
  readonly citations?: readonly Citation[]
}

export interface QueryInput {
  readonly text: string
  readonly file?: string
  readonly repo?: string
  readonly limit?: number
}

export interface QueryResult extends Entry {
  readonly provider?: string
  readonly repo?: string
  readonly confidence?: number
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

export const defaultLayer = Layer.succeed(
  Service,
  Service.of({
    query: MemoryIndex.query,
  }),
)

export * as Memory from "."
