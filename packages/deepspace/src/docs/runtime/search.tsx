import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { DocsSearchEntry } from '../types'
import { useDialogFocus } from './dialog'
import { ChevronRightIcon, OrbitMark, SearchIcon, SparkIcon } from './icons'

export function SearchCommand({
  assistantEnabled,
  name,
  onAssistantOpen,
  onClose,
  onNavigate,
  open,
}: {
  assistantEnabled: boolean
  name: string
  onAssistantOpen: (seed?: string) => void
  onClose: () => void
  onNavigate?: (href: string) => void
  open: boolean
}): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState<DocsSearchEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  useDialogFocus(open, dialogRef, onClose)
  useEffect(() => {
    if (!open || index || loading) return
    setLoading(true)
    fetch('/_docs/search.json')
      .then((response) => response.ok ? response.json() as Promise<DocsSearchEntry[]> : [])
      .then(setIndex)
      .catch(() => setIndex([]))
      .finally(() => setLoading(false))
  }, [index, loading, open])
  useEffect(() => {
    if (!open) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [open])
  const preparedIndex = useMemo(() => prepareSearchIndex(index ?? []), [index])
  const results = useMemo(() => rankSearch(preparedIndex, query), [preparedIndex, query])
  if (!open) return null
  const selectableCount = results.length + (assistantEnabled && query.trim() ? 1 : 0)
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' && selectableCount > 0) {
      event.preventDefault()
      setActiveIndex((current) => (current + 1) % selectableCount)
    } else if (event.key === 'ArrowUp' && selectableCount > 0) {
      event.preventDefault()
      setActiveIndex((current) => (current - 1 + selectableCount) % selectableCount)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (activeIndex < results.length && results[activeIndex]) {
        onClose()
        if (onNavigate) onNavigate(results[activeIndex].route)
        else window.location.assign(results[activeIndex].route)
      } else if (assistantEnabled && query.trim()) {
        onAssistantOpen(query.trim())
      }
    }
  }
  return (
    <div className="docs-modal-layer docs-search-layer" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <div className="docs-search-dialog" role="dialog" aria-modal="true" aria-label="Search documentation" ref={dialogRef}>
        <label className="docs-search-input">
          <SearchIcon />
          <input
            aria-activedescendant={selectableCount > 0 ? `docs-search-option-${activeIndex}` : undefined}
            aria-controls="docs-search-results"
            aria-expanded="true"
            aria-label={`Search ${name} documentation`}
            autoComplete="off"
            data-autofocus
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }}
            onKeyDown={handleKeyDown}
            placeholder={`Search ${name}`}
            role="combobox"
            value={query}
          />
          <kbd>Esc</kbd>
        </label>
        <div className="docs-search-results" id="docs-search-results" role="listbox" aria-label="Search results">
          {!query.trim() && (
            <div className="docs-search-empty"><OrbitMark /><strong>Find an answer in this commit</strong><span>Search pages, headings, APIs, and examples.</span></div>
          )}
          {query.trim() && loading && <div className="docs-search-state">Searching this documentation…</div>}
          {query.trim() && !loading && results.length === 0 && <div className="docs-search-state">No documentation matched “{query.trim()}”.</div>}
          {results.map((result, resultIndex) => (
            <a
              aria-selected={activeIndex === resultIndex}
              className={activeIndex === resultIndex ? 'docs-search-result is-active' : 'docs-search-result'}
              href={result.route}
              id={`docs-search-option-${resultIndex}`}
              key={result.route}
              onClick={onClose}
              onMouseEnter={() => setActiveIndex(resultIndex)}
              role="option"
            >
              <span><strong>{highlightMatch(result.title, query)}</strong><small>{result.description ?? result.headings[0] ?? result.text.slice(0, 150)}</small></span>
              <ChevronRightIcon />
            </a>
          ))}
          {assistantEnabled && query.trim() && (
            <button
              aria-selected={activeIndex === results.length}
              className={activeIndex === results.length ? 'docs-search-assistant is-active' : 'docs-search-assistant'}
              id={`docs-search-option-${results.length}`}
              onClick={() => onAssistantOpen(query.trim())}
              onMouseEnter={() => setActiveIndex(results.length)}
              role="option"
              type="button"
            ><SparkIcon /><span><strong>Ask DeepSpace</strong><small>Answer from the current documentation with citations</small></span><ChevronRightIcon /></button>
          )}
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> select</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></footer>
      </div>
    </div>
  )
}

interface PreparedSearchEntry {
  entry: DocsSearchEntry
  title: string
  headings: string
  haystack: string
}

function prepareSearchIndex(index: DocsSearchEntry[]): PreparedSearchEntry[] {
  return index.map((entry) => ({
    entry,
    title: normalizeSearch(entry.title),
    headings: normalizeSearch(entry.headings.join(' ')),
    haystack: normalizeSearch(`${entry.description ?? ''} ${entry.text}`),
  }))
}

function rankSearch(index: PreparedSearchEntry[], query: string): DocsSearchEntry[] {
  const normalized = normalizeSearch(query)
  if (!normalized) return []
  const tokens = normalized.split(' ').filter(Boolean)
  return index
    .map(({ entry, title, headings, haystack }) => {
      let score = title === normalized ? 180 : title.startsWith(normalized) ? 110 : title.includes(normalized) ? 75 : 0
      if (headings.includes(normalized)) score += 55
      for (const token of tokens) {
        if (title.includes(token)) score += 24
        else if (headings.includes(token)) score += 14
        else if (haystack.includes(token)) score += 5
        else score -= 18
      }
      return { entry, score }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.route.localeCompare(right.entry.route))
    .slice(0, 10)
    .map((item) => item.entry)
}

function highlightMatch(value: string, query: string): ReactNode {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return value
  const index = value.toLowerCase().indexOf(normalizedQuery.toLowerCase())
  if (index < 0) return value
  return <>{value.slice(0, index)}<mark>{value.slice(index, index + normalizedQuery.length)}</mark>{value.slice(index + normalizedQuery.length)}</>
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
