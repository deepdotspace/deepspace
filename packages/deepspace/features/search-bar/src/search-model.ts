import { useMemo } from 'react'

export interface HighlightedPart {
  text: string
  match: boolean
}

export interface UseSearchIndexOptions<T> {
  items: T[]
  query: string
  getText: (item: T) => Array<string | number | null | undefined>
  limit?: number
}

/** Rank a local list without owning app state, persistence, or networking. */
export function useSearchIndex<T>({
  items,
  query,
  getText,
  limit = 20,
}: UseSearchIndexOptions<T>): T[] {
  return useMemo(() => {
    const resultLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : items.length
    const normalizedQuery = normalize(query)
    if (!normalizedQuery) return items.slice(0, resultLimit)

    return items
      .map((item, index) => {
        const haystack = getText(item)
          .filter((value): value is string | number => value !== null && value !== undefined)
          .map(String)
          .join(' ')
        return { item, index, score: scoreText(haystack, normalizedQuery) }
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, resultLimit)
      .map((entry) => entry.item)
  }, [getText, items, limit, query])
}

export function getHighlightedParts(text: string, query: string): HighlightedPart[] {
  const normalizedQuery = normalize(query)
  if (!text || !normalizedQuery) return [{ text, match: false }]

  const normalizedText = text.toLowerCase()
  const parts: HighlightedPart[] = []
  let cursor = 0
  let index = normalizedText.indexOf(normalizedQuery)

  while (index !== -1) {
    if (index > cursor) parts.push({ text: text.slice(cursor, index), match: false })
    parts.push({ text: text.slice(index, index + normalizedQuery.length), match: true })
    cursor = index + normalizedQuery.length
    index = normalizedText.indexOf(normalizedQuery, cursor)
  }

  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false })
  return parts.length > 0 ? parts : [{ text, match: false }]
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function scoreText(value: string, query: string): number {
  const text = normalize(value)
  if (!text || !query) return 0
  if (text === query) return 100
  if (text.startsWith(query)) return 80
  if (text.includes(` ${query}`)) return 60
  if (text.includes(query)) return 40

  const terms = query.split(/\s+/).filter(Boolean)
  return terms.length > 1 && terms.every((term) => text.includes(term)) ? 20 : 0
}
