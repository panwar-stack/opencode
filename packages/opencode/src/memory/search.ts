export const DEFAULT_LIMITS = {
  commits: 20,
  summaries: 5,
} as const

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "were",
  "with",
])

export type TokenizeOptions = {
  readonly unique?: boolean
}

export type SparseDocument = {
  readonly id: string
  readonly token_text: string
}

export type MatchedToken = {
  readonly token: string
  readonly query_count: number
  readonly document_count: number
  readonly document_frequency: number
  readonly idf: number
}

export type RankedDocument<T extends SparseDocument = SparseDocument> = T & {
  readonly score: number
  readonly strength: "strong" | "weak"
  readonly matched_tokens: MatchedToken[]
  readonly exact_file_path_match: boolean
  readonly exact_identifier_match: boolean
}

export function tokenize(input: string, options: TokenizeOptions = {}) {
  const normalized = rawTokens(input).flatMap((token) => expandToken(token))
  if (!options.unique) return normalized
  return [...new Set(normalized)]
}

export function tokenText(input: string) {
  return tokenize(input).join(" ")
}

export function rankDocuments<T extends SparseDocument>(query: string, documents: readonly T[], limit = documents.length) {
  const queryTokens = countTokens(tokenize(query))
  const terms = [...queryTokens.keys()]
  if (!terms.length || !documents.length) return []

  const tokenized = documents.map((document) => ({ document, counts: countTokens(document.token_text.split(/\s+/).filter(Boolean)) }))
  const averageLength = tokenized.reduce((sum, item) => sum + countTotal(item.counts), 0) / tokenized.length
  const documentFrequency = new Map(
    terms.map((term) => [term, tokenized.filter((item) => item.counts.has(term)).length] as const),
  )
  const exactFilePaths = exactSignalTokens(query).filter((term) => term.includes("/"))
  const exactIdentifiers = exactSignalTokens(query).filter((term) => !term.includes("/"))

  return tokenized
    .map((item) => {
      const matched_tokens = terms
        .map((term) => {
          const document_count = item.counts.get(term) ?? 0
          if (!document_count) return undefined
          const idf = inverseDocumentFrequency(tokenized.length, documentFrequency.get(term) ?? 0)
          return {
            token: term,
            query_count: queryTokens.get(term) ?? 0,
            document_count,
            document_frequency: documentFrequency.get(term) ?? 0,
            idf,
          } satisfies MatchedToken
        })
        .filter((match): match is MatchedToken => match !== undefined)
      const exact_file_path_match = exactFilePaths.some((term) => item.counts.has(term))
      const exact_identifier_match = exactIdentifiers.some((term) => item.counts.has(term))
      const score =
        matched_tokens.reduce(
          (sum, match) =>
            sum +
            bm25({
              termFrequency: match.document_count,
              documentLength: countTotal(item.counts),
              averageLength,
              idf: match.idf,
            }) *
              match.query_count,
          0,
        ) +
        (exact_file_path_match ? 2 : 0) +
        (exact_identifier_match ? 1 : 0)
      return {
        ...item.document,
        score,
        strength: score >= 2 || exact_file_path_match || exact_identifier_match ? "strong" : "weak",
        matched_tokens,
        exact_file_path_match,
        exact_identifier_match,
      } satisfies RankedDocument<T>
    })
    .filter((item) => item.score > 0)
    .toSorted((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit)
}

function expandToken(input: string) {
  const token = input.toLowerCase()
  if (STOP_WORDS.has(token)) return []
  return [token, ...splitToken(input)]
    .map((item) => item.toLowerCase())
    .filter((item) => item && !STOP_WORDS.has(item))
}

function exactSignalTokens(input: string) {
  return rawTokens(input)
    .filter((token) => token.includes("/") || /[._:-]/.test(token) || /[a-z0-9][A-Z]/.test(token))
    .map((token) => token.toLowerCase())
}

function rawTokens(input: string) {
  return input.match(/[#]?(?:\.{0,2}\/|\/)?[a-zA-Z0-9_$][a-zA-Z0-9_$./:-]*/g) ?? []
}

function splitToken(input: string) {
  return input
    .split(/[./:_-]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .filter(Boolean)
}

function countTokens(tokens: readonly string[]) {
  return tokens.reduce((counts, token) => counts.set(token, (counts.get(token) ?? 0) + 1), new Map<string, number>())
}

function countTotal(counts: ReadonlyMap<string, number>) {
  return [...counts.values()].reduce((sum, count) => sum + count, 0)
}

function inverseDocumentFrequency(total: number, frequency: number) {
  return Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5))
}

function bm25(input: { termFrequency: number; documentLength: number; averageLength: number; idf: number }) {
  const k1 = 1.2
  const b = 0.75
  return (
    input.idf *
    ((input.termFrequency * (k1 + 1)) /
      (input.termFrequency + k1 * (1 - b + b * (input.documentLength / input.averageLength))))
  )
}

export * as MemorySearch from "./search"
