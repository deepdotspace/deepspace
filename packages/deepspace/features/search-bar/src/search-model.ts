import { useEffect, useMemo, useRef, useState } from 'react'

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

export interface UseAsyncSearchOptions<T> {
  query: string
  search: (query: string) => Promise<T[]>
  minLength?: number
  delayMs?: number
}

export function useAsyncSearch<T>({
  query,
  search,
  minLength = 2,
  delayMs = 250,
}: UseAsyncSearchOptions<T>) {
  const [items, setItems] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  useEffect(() => {
    const trimmed = query.trim()
    const currentRequest = ++requestId.current
    const requiredLength = Number.isFinite(minLength) ? Math.max(0, Math.floor(minLength)) : 2
    const waitMs = Number.isFinite(delayMs)
      ? Math.min(60_000, Math.max(0, Math.floor(delayMs)))
      : 250

    if (trimmed.length < requiredLength) {
      setItems([])
      setLoading(false)
      setError(null)
      return
    }

    setLoading(true)
    setError(null)

    const timer = window.setTimeout(() => {
      void search(trimmed)
        .then((results) => {
          if (requestId.current !== currentRequest) return
          setItems(results)
          setError(null)
        })
        .catch((searchError) => {
          if (requestId.current !== currentRequest) return
          setItems([])
          setError(searchError instanceof Error ? searchError.message : 'Search failed')
        })
        .finally(() => {
          if (requestId.current === currentRequest) setLoading(false)
        })
    }, waitMs)

    return () => {
      window.clearTimeout(timer)
      if (requestId.current === currentRequest) requestId.current += 1
    }
  }, [delayMs, minLength, query, search])

  return { items, loading, error }
}

export type RecentSearchEntry = { kind: 'item'; itemId: string } | { kind: 'query'; query: string }

export function createRecentStorageKey(
  title: string,
  placeholder: string,
  triggerLabel: string,
): string {
  const scope =
    [title, placeholder, triggerLabel].map((value) => value.trim().toLowerCase()).find(Boolean) ??
    'search'
  const normalizedScope = scope.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'search'
  return `deepspace:search-bar:recent:${normalizedScope}`
}

export function readRecentSearches(storageKey: string, maxItems: number): RecentSearchEntry[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRecentSearchEntry).slice(0, normalizeLimit(maxItems))
  } catch {
    return []
  }
}

export function rememberRecentItem(
  storageKey: string,
  itemId: string,
  maxItems: number,
): RecentSearchEntry[] {
  if (!itemId) return readRecentSearches(storageKey, maxItems)
  return rememberRecent(
    storageKey,
    { kind: 'item', itemId },
    (entry) => entry.kind === 'item' && entry.itemId === itemId,
    maxItems,
  )
}

export function rememberRecentQuery(
  storageKey: string,
  rawQuery: string,
  maxItems: number,
): RecentSearchEntry[] {
  const query = rawQuery.trim()
  const normalizedQuery = normalize(query)
  if (!normalizedQuery) return readRecentSearches(storageKey, maxItems)
  return rememberRecent(
    storageKey,
    { kind: 'query', query },
    (entry) => entry.kind === 'query' && normalize(entry.query) === normalizedQuery,
    maxItems,
  )
}

function rememberRecent(
  storageKey: string,
  recent: RecentSearchEntry,
  matches: (entry: RecentSearchEntry) => boolean,
  maxItems: number,
): RecentSearchEntry[] {
  const next = [
    recent,
    ...readRecentSearches(storageKey, maxItems).filter((entry) => !matches(entry)),
  ].slice(0, normalizeLimit(maxItems))

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(next))
  } catch {
    // Persistence is optional; search continues with the in-memory result.
  }
  return next
}

function isRecentSearchEntry(value: unknown): value is RecentSearchEntry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RecentSearchEntry>
  if (candidate.kind === 'item') return typeof candidate.itemId === 'string' && !!candidate.itemId
  return (
    candidate.kind === 'query' && typeof candidate.query === 'string' && !!candidate.query.trim()
  )
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
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
