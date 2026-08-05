import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { DocumentationSearchEntry } from '../types'
import { documentationPublicPath } from '../routing'
import { documentationSubject } from '../text'
import { useDialogFocus } from './dialog'
import { ChevronRightIcon, OrbitMark, SearchIcon, SparkIcon } from './icons'

export function SearchCommand({
  assistantEnabled,
  basePath,
  name,
  onAssistantOpen,
  onClose,
  onNavigate,
  open,
}: {
  assistantEnabled: boolean
  basePath: string
  name: string
  onAssistantOpen: (seed?: string) => void
  onClose: () => void
  onNavigate?: (href: string) => void
  open: boolean
}): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState<DocumentationSearchEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  useDialogFocus(open, dialogRef, onClose)
  useEffect(() => {
    if (!open || index || loading) return
    setLoading(true)
    fetch(documentationPublicPath(basePath, '/search.json'))
      .then((response) => response.ok ? response.json() as Promise<DocumentationSearchEntry[]> : [])
      .then(setIndex)
      .catch(() => setIndex([]))
      .finally(() => setLoading(false))
  }, [basePath, index, loading, open])
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
        const href = documentationPublicPath(basePath, results[activeIndex].route)
        if (onNavigate) onNavigate(href)
        else window.location.assign(href)
      } else if (assistantEnabled && query.trim()) {
        onAssistantOpen(query.trim())
      }
    }
  }
  return (
    <div className="documentation-modal-layer documentation-search-layer" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <div className="documentation-search-dialog" role="dialog" aria-modal="true" aria-label="Search documentation" ref={dialogRef}>
        <label className="documentation-search-input">
          <SearchIcon />
          <input
            aria-activedescendant={selectableCount > 0 ? `documentation-search-option-${activeIndex}` : undefined}
            aria-controls="documentation-search-results"
            aria-expanded="true"
            aria-label={`Search ${documentationSubject(name)}`}
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
        <div className="documentation-search-results" id="documentation-search-results" role="listbox" aria-label="Search results">
          {!query.trim() && (
            <div className="documentation-search-empty"><OrbitMark /><strong>Find an answer in this commit</strong><span>Search pages, headings, APIs, and examples.</span></div>
          )}
          {query.trim() && loading && <div className="documentation-search-state">Searching this documentation…</div>}
          {query.trim() && !loading && results.length === 0 && <div className="documentation-search-state">No documentation matched “{query.trim()}”.</div>}
          {results.map((result, resultIndex) => (
            <a
              aria-selected={activeIndex === resultIndex}
              className={activeIndex === resultIndex ? 'documentation-search-result is-active' : 'documentation-search-result'}
              href={documentationPublicPath(basePath, result.route)}
              id={`documentation-search-option-${resultIndex}`}
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
              className={activeIndex === results.length ? 'documentation-search-assistant is-active' : 'documentation-search-assistant'}
              id={`documentation-search-option-${results.length}`}
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
  entry: DocumentationSearchEntry
  title: string
  headings: string
  haystack: string
}

function prepareSearchIndex(index: DocumentationSearchEntry[]): PreparedSearchEntry[] {
  return index.map((entry) => ({
    entry,
    title: normalizeSearch(entry.title),
    headings: normalizeSearch(entry.headings.join(' ')),
    haystack: normalizeSearch(`${entry.description ?? ''} ${entry.text}`),
  }))
}

function rankSearch(index: PreparedSearchEntry[], query: string): DocumentationSearchEntry[] {
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
