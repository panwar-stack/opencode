export interface SearchInput {
  readonly text: string
  readonly file?: string
  readonly limit?: number
}

interface SearchEntry {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly file?: string
  readonly files?: readonly string[]
}

export function queryEntries<T extends SearchEntry>(entries: readonly T[], input: SearchInput) {
  const terms = input.text
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/)
    .filter(Boolean)

  if (terms.length === 0) return []

  const results = entries
    .filter((entry) => matchesFile(entry, input.file))
    .map((entry) => ({ ...entry, score: scoreEntry(entry, input.text.toLowerCase(), terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))

  if (!input.limit || input.limit < 1) return results
  return results.slice(0, input.limit)
}

function matchesFile(entry: SearchEntry, file: string | undefined) {
  if (!file) return true
  if (entry.file === file) return true
  return entry.files?.includes(file) ?? false
}

function scoreEntry(entry: SearchEntry, query: string, terms: string[]) {
  const searchable = [entry.title, entry.body, entry.file ?? "", ...(entry.files ?? [])].join("\n").toLowerCase()
  return (searchable.includes(query) ? 10 : 0) + terms.filter((term) => searchable.includes(term)).length
}
