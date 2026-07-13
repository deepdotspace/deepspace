import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Badge, Button, EmptyState, SearchInput, cn } from '@/components/ui'
import { Loader2 } from 'lucide-react'

export interface SearchItem {
  id: string
  title: string
  subtitle?: string
  description?: string
  group?: string
  keywords?: string[]
  meta?: ReactNode
  disabled?: boolean
}

export interface HighlightedPart {
  text: string
  match: boolean
}

export type SearchResultRenderer<T extends SearchItem = SearchItem> = (item: T, query: string) => ReactNode

interface SearchBaseProps<T extends SearchItem = SearchItem> {
  query: string
  onQueryChange: (query: string) => void
  items: T[]
  onSelect: (item: T) => void
  placeholder?: string
  loading?: boolean
  error?: string | null
  emptyTitle?: string
  emptyDescription?: string
  className?: string
  renderTitle?: SearchResultRenderer<T>
  renderSubtitle?: SearchResultRenderer<T>
  renderDescription?: SearchResultRenderer<T>
}

export interface SearchOverlayProps<T extends SearchItem = SearchItem> extends SearchBaseProps<T> {
  open: boolean
  onOpenChange: (open: boolean) => void
  triggerLabel?: string
  title?: string
  description?: string
  onSearchSubmit?: (query: string) => void
  searchSubmitLabel?: string
  showRecentSearches?: boolean
  recentStorageKey?: string
  maxRecentItems?: number
}

export interface InlineSearchProps<T extends SearchItem = SearchItem> extends SearchBaseProps<T> {
  label?: string
  description?: string
  dimContent?: boolean
  openOnFocus?: boolean
  maxResultsHeightClassName?: string
}

export interface UseSearchIndexOptions<T> {
  items: T[]
  query: string
  getText: (item: T) => Array<string | number | null | undefined>
  limit?: number
}

export function useSearchIndex<T>({ items, query, getText, limit = 20 }: UseSearchIndexOptions<T>): T[] {
  return useMemo(() => {
    const normalizedQuery = normalize(query)
    if (!normalizedQuery) return items.slice(0, limit)

    const scored = items
      .map((item, index) => {
        const haystack = getText(item)
          .filter((value): value is string | number => value !== null && value !== undefined)
          .map(String)
          .join(' ')
        const score = scoreText(haystack, normalizedQuery)
        return { item, index, score }
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)

    return scored.slice(0, limit).map((entry) => entry.item)
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
    if (index > cursor) {
      parts.push({ text: text.slice(cursor, index), match: false })
    }
    parts.push({ text: text.slice(index, index + normalizedQuery.length), match: true })
    cursor = index + normalizedQuery.length
    index = normalizedText.indexOf(normalizedQuery, cursor)
  }

  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), match: false })
  }

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
    requestId.current += 1
    const current = requestId.current

    if (trimmed.length < minLength) {
      setItems([])
      setLoading(false)
      setError(null)
      return
    }

    setLoading(true)
    setError(null)

    const timer = window.setTimeout(() => {
      search(trimmed)
        .then((results) => {
          if (requestId.current !== current) return
          setItems(results)
          setError(null)
        })
        .catch((err) => {
          if (requestId.current !== current) return
          setItems([])
          setError(err instanceof Error ? err.message : 'Search failed')
        })
        .finally(() => {
          if (requestId.current === current) setLoading(false)
        })
    }, delayMs)

    return () => window.clearTimeout(timer)
  }, [delayMs, minLength, query, search])

  return { items, loading, error }
}

export function SearchOverlay<T extends SearchItem = SearchItem>({
  open,
  onOpenChange,
  query,
  onQueryChange,
  items,
  onSelect,
  triggerLabel = 'Search',
  placeholder = 'Search...',
  title = 'Search',
  description,
  onSearchSubmit,
  searchSubmitLabel = 'Search all results',
  loading = false,
  error = null,
  emptyTitle = 'No matches',
  emptyDescription = 'Try another search term.',
  className,
  renderTitle,
  renderSubtitle,
  renderDescription,
  showRecentSearches = true,
  recentStorageKey,
  maxRecentItems = 5,
}: SearchOverlayProps<T>) {
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [recentItems, setRecentItems] = useState<SearchItem[]>([])
  const resolvedRecentStorageKey = recentStorageKey ?? createRecentStorageKey(title, placeholder, triggerLabel)
  const showRecents = showRecentSearches && query.trim() === '' && recentItems.length > 0
  const visibleItems = showRecents
    ? recentItems.map((item) => ({ ...item, group: 'Recent' }))
    : items
  const canSubmitSearch = Boolean(onSearchSubmit && query.trim())

  function submitSearch(rawQuery: string) {
    const trimmed = rawQuery.trim()
    if (!trimmed || !onSearchSubmit) return
    const nextRecentItems = writeRecentSearchQuery(resolvedRecentStorageKey, trimmed, maxRecentItems)
    setRecentItems(nextRecentItems)
    onSearchSubmit(trimmed)
    onOpenChange(false)
  }

  useEffect(() => {
    if (!open) return
    window.setTimeout(() => inputRef.current?.focus(), 0)
    if (showRecentSearches) {
      setRecentItems(readRecentSearchItems(resolvedRecentStorageKey, maxRecentItems))
    }
  }, [maxRecentItems, open, resolvedRecentStorageKey, showRecentSearches])

  useEffect(() => {
    if (!open) return

    function onPointerDown(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        onOpenChange(false)
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [onOpenChange, open])

  return (
    <div className={className}>
      <Button type="button" onClick={() => onOpenChange(true)} data-testid="search-trigger">
        {triggerLabel}
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm px-3 py-4 sm:py-16" data-testid="search-overlay">
          <div
            ref={panelRef}
            className="mx-auto flex max-h-[min(720px,calc(100vh-2rem))] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
          >
            <div className="border-b border-border p-4">
              <div className="mb-3 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">{title}</h2>
                  {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
              </div>
              <SearchInput
                ref={inputRef}
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                onClear={() => onQueryChange('')}
                placeholder={placeholder}
                aria-label={placeholder}
                data-testid="search-input"
              />
              {canSubmitSearch && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2 w-full justify-start text-muted-foreground"
                  onClick={() => submitSearch(query)}
                  data-testid="search-submit"
                >
                  {searchSubmitLabel}: "{query.trim()}"
                </Button>
              )}
            </div>

            <SearchPanel
              items={visibleItems}
              query={showRecents ? '' : query}
              onSelect={(item) => {
                if (showRecents && isRecentSearchQueryItem(item)) {
                  onQueryChange(item.title)
                  submitSearch(item.title)
                  return
                }
                if (!showRecents) {
                  const nextRecentItems = writeRecentSearchItem(resolvedRecentStorageKey, item, maxRecentItems)
                  setRecentItems(nextRecentItems)
                }
                onSelect(item as T)
                onOpenChange(false)
              }}
              onClose={() => onOpenChange(false)}
              loading={loading}
              error={error}
              emptyTitle={emptyTitle}
              emptyDescription={emptyDescription}
              onSubmitQuery={onSearchSubmit ? submitSearch : undefined}
              renderTitle={renderTitle as SearchResultRenderer<SearchItem> | undefined}
              renderSubtitle={renderSubtitle as SearchResultRenderer<SearchItem> | undefined}
              renderDescription={renderDescription as SearchResultRenderer<SearchItem> | undefined}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export function InlineSearch<T extends SearchItem = SearchItem>({
  query,
  onQueryChange,
  items,
  onSelect,
  placeholder = 'Search...',
  label,
  description,
  loading = false,
  error = null,
  emptyTitle = 'No matches',
  emptyDescription = 'Try another search term.',
  dimContent = false,
  openOnFocus = true,
  maxResultsHeightClassName = 'max-h-80',
  className,
  renderTitle,
  renderSubtitle,
  renderDescription,
}: InlineSearchProps<T>) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const showPanel = open && (openOnFocus || query.trim().length > 0)

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  return (
    <div ref={wrapperRef} className={cn('relative', className)} data-testid="inline-search">
      {dimContent && showPanel && (
        <div className="fixed inset-0 z-30 bg-background/50 backdrop-blur-[2px]" aria-hidden="true" data-testid="inline-search-dimmer" />
      )}

      <div className="relative z-40">
        {(label || description) && (
          <div className="mb-2">
            {label && <label className="text-sm font-medium text-foreground">{label}</label>}
            {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
          </div>
        )}
        <SearchInput
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onClear={() => {
            onQueryChange('')
            setOpen(true)
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          data-testid="inline-search-input"
        />

        {showPanel && (
          <div className={cn(
            'absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-xl border border-border bg-card shadow-xl',
            maxResultsHeightClassName
          )} data-testid="inline-search-panel">
            <SearchPanel
              items={items}
              query={query}
              onSelect={(item) => {
                onSelect(item)
                setOpen(false)
              }}
              onClose={() => setOpen(false)}
              loading={loading}
              error={error}
              emptyTitle={emptyTitle}
              emptyDescription={emptyDescription}
              compact
              renderTitle={renderTitle}
              renderSubtitle={renderSubtitle}
              renderDescription={renderDescription}
            />
          </div>
        )}
      </div>
    </div>
  )
}

interface SearchPanelProps<T extends SearchItem = SearchItem> {
  items: T[]
  query: string
  onSelect: (item: T) => void
  onClose: () => void
  loading?: boolean
  error?: string | null
  emptyTitle: string
  emptyDescription: string
  compact?: boolean
  onSubmitQuery?: (query: string) => void
  renderTitle?: SearchResultRenderer<T>
  renderSubtitle?: SearchResultRenderer<T>
  renderDescription?: SearchResultRenderer<T>
}

function SearchPanel<T extends SearchItem = SearchItem>({
  items,
  query,
  onSelect,
  onClose,
  loading = false,
  error = null,
  emptyTitle,
  emptyDescription,
  compact = false,
  onSubmitQuery,
  renderTitle,
  renderSubtitle,
  renderDescription,
}: SearchPanelProps<T>) {
  const [activeIndex, setActiveIndex] = useState(0)
  const enabledItems = items.filter((item) => !item.disabled)

  useEffect(() => {
    setActiveIndex(0)
  }, [items])

  function moveActive(delta: number) {
    if (enabledItems.length === 0) return
    setActiveIndex((current) => (current + delta + enabledItems.length) % enabledItems.length)
  }

  function selectItem(item: T) {
    if (item.disabled) return
    onSelect(item)
  }

  useEffect(() => {
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  function onKeyDown(event: globalThis.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveActive(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(-1)
    } else if (event.key === 'Enter') {
      if (onSubmitQuery && query.trim()) {
        event.preventDefault()
        onSubmitQuery(query)
        return
      }
      const active = enabledItems[activeIndex]
      if (active) {
        event.preventDefault()
        selectItem(active)
      }
    }
  }

  return (
    <div
      className={cn('min-h-0 flex-1 overflow-y-auto p-2', compact ? 'max-h-80' : '')}
      tabIndex={-1}
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground" data-testid="search-loading">
          <Loader2 className="h-4 w-4 animate-spin" />
          Searching...
        </div>
      ) : error ? (
        <div className="px-3 py-10 text-center text-sm text-destructive" data-testid="search-error">
          {error}
        </div>
      ) : items.length === 0 ? (
        <div data-testid="search-empty">
          <EmptyState
            title={emptyTitle}
            description={emptyDescription}
            className={compact ? 'py-8' : undefined}
          />
        </div>
      ) : (
        <SearchResultList
          items={items}
          query={query}
          activeItemId={enabledItems[activeIndex]?.id}
          onSelect={selectItem}
          renderTitle={renderTitle}
          renderSubtitle={renderSubtitle}
          renderDescription={renderDescription}
        />
      )}
    </div>
  )
}

export interface SearchResultListProps<T extends SearchItem = SearchItem> {
  items: T[]
  query?: string
  activeItemId?: string
  onSelect: (item: T) => void
  renderTitle?: SearchResultRenderer<T>
  renderSubtitle?: SearchResultRenderer<T>
  renderDescription?: SearchResultRenderer<T>
}

export function SearchResultList<T extends SearchItem = SearchItem>({
  items,
  query = '',
  activeItemId,
  onSelect,
  renderTitle,
  renderSubtitle,
  renderDescription,
}: SearchResultListProps<T>) {
  const groups = groupItems(items)

  return (
    <div className="space-y-3" data-testid="search-results">
      {groups.map(([group, groupItems]) => (
        <section key={group}>
          <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {group}
          </div>
          <div className="space-y-1">
            {groupItems.map((item) => {
              const active = item.id === activeItemId
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={item.disabled}
                  onClick={() => onSelect(item)}
                  className={cn(
                    'flex w-full items-start justify-between gap-3 rounded-lg px-3 py-3 text-left transition-colors',
                    active ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/70',
                    item.disabled && 'cursor-not-allowed opacity-50'
                  )}
                  data-testid="search-result"
                  data-active={active ? 'true' : 'false'}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {renderTitle ? renderTitle(item, query) : item.title}
                    </span>
                    {item.subtitle && (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {renderSubtitle ? renderSubtitle(item, query) : item.subtitle}
                      </span>
                    )}
                    {item.description && (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {renderDescription ? renderDescription(item, query) : item.description}
                      </span>
                    )}
                  </span>
                  {item.meta && <span className="shrink-0 text-xs text-muted-foreground">{item.meta}</span>}
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

export function toSearchItem(item: SearchItem): SearchItem {
  return item
}

function createRecentStorageKey(title: string, placeholder: string, triggerLabel: string) {
  const scope = [title, placeholder, triggerLabel]
    .map((value) => value.trim().toLowerCase())
    .find(Boolean) ?? 'search'
  const normalizedScope = scope.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'search'
  return `deepspace:search-bar:recent:${normalizedScope}`
}

function readRecentSearchItems(storageKey: string, maxItems: number): SearchItem[] {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(isStoredSearchItem)
      .slice(0, maxItems)
      .map((item) => ({ ...item, group: 'Recent' }))
  } catch {
    return []
  }
}

function writeRecentSearchItem(storageKey: string, item: SearchItem, maxItems: number): SearchItem[] {
  const recentItem = toStoredSearchItem(item)
  const next = [
    recentItem,
    ...readRecentSearchItems(storageKey, maxItems).filter((existing) => existing.id !== recentItem.id),
  ].slice(0, maxItems)

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(next))
  } catch {
    // Ignore storage failures; search should still work without persistence.
  }

  return next.map((storedItem) => ({ ...storedItem, group: 'Recent' }))
}

function writeRecentSearchQuery(storageKey: string, query: string, maxItems: number): SearchItem[] {
  const recentItem = toStoredSearchQuery(query)
  const next = [
    recentItem,
    ...readRecentSearchItems(storageKey, maxItems).filter((existing) => existing.id !== recentItem.id),
  ].slice(0, maxItems)

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(next))
  } catch {
    // Ignore storage failures; search should still work without persistence.
  }

  return next.map((storedItem) => ({ ...storedItem, group: 'Recent' }))
}

function toStoredSearchItem(item: SearchItem): SearchItem {
  return {
    id: item.id,
    title: item.title,
    subtitle: item.subtitle,
    description: item.description,
    group: 'Recent',
    keywords: item.keywords,
    disabled: item.disabled,
  }
}

function toStoredSearchQuery(query: string): SearchItem {
  return {
    id: `search-query:${normalize(query)}`,
    title: query,
    subtitle: 'Search query',
    group: 'Recent',
    keywords: [query],
  }
}

function isRecentSearchQueryItem(item: SearchItem) {
  return item.id.startsWith('search-query:')
}

function isStoredSearchItem(value: unknown): value is SearchItem {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SearchItem>
  return typeof candidate.id === 'string' && typeof candidate.title === 'string'
}

function groupItems<T extends SearchItem>(items: T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const group = item.group ?? 'Results'
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group)!.push(item)
  }
  return Array.from(groups.entries())
}

function normalize(value: string) {
  return value.trim().toLowerCase()
}

function scoreText(value: string, query: string) {
  const text = normalize(value)
  if (!text || !query) return 0
  if (text === query) return 100
  if (text.startsWith(query)) return 80
  if (text.includes(` ${query}`)) return 60
  if (text.includes(query)) return 40

  const terms = query.split(/\s+/).filter(Boolean)
  if (terms.length > 1 && terms.every((term) => text.includes(term))) return 20
  return 0
}

export function ResultCountBadge({ count }: { count: number }) {
  return <Badge variant="secondary" size="sm">{count} results</Badge>
}
