import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { DocumentationHeading, DocumentationSearchEntry } from '../types'
import { documentationPublicPath } from '../routing'
import { documentationSubject } from '../text'
import { useDialogFocus } from './dialog'
import { ChevronRightIcon, FileIcon, HashIcon, OrbitMark, SearchIcon, SparkIcon } from './icons'

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
  const resultsRef = useRef<HTMLDivElement>(null)
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
  // Arrowing past the visible rows must bring the highlighted one into view.
  useEffect(() => {
    resultsRef.current
      ?.querySelector(`#documentation-search-option-${activeIndex}`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, query])
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
      const result = activeIndex < results.length ? results[activeIndex] : undefined
      if (result) {
        onClose()
        const href = documentationPublicPath(basePath, result.href)
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
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            data-autofocus
            enterKeyHint="go"
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }}
            onKeyDown={handleKeyDown}
            placeholder={`Search ${name}`}
            role="combobox"
            spellCheck={false}
            value={query}
          />
          <kbd>Esc</kbd>
        </label>
        <div className="documentation-search-results" id="documentation-search-results" ref={resultsRef} role="listbox" aria-label="Search results">
          {!query.trim() && (
            <div className="documentation-search-empty"><OrbitMark /><strong>Find an answer in these docs</strong><span>Search pages, headings, APIs, and examples.</span></div>
          )}
          {query.trim() && loading && <div className="documentation-search-state">Searching this documentation…</div>}
          {query.trim() && !loading && results.length === 0 && <div className="documentation-search-state">No documentation matched “{query.trim()}”.</div>}
          {results.map((result, resultIndex) => (
            <a
              aria-selected={activeIndex === resultIndex}
              className={activeIndex === resultIndex ? 'documentation-search-result is-active' : 'documentation-search-result'}
              href={documentationPublicPath(basePath, result.href)}
              id={`documentation-search-option-${resultIndex}`}
              key={result.href}
              onClick={onClose}
              onMouseEnter={() => setActiveIndex(resultIndex)}
              role="option"
            >
              <span className="documentation-search-kind">{result.kind === 'section' ? <HashIcon /> : <FileIcon />}</span>
              <span className="documentation-search-copy">
                <strong>{highlightMatch(result.title, query)}</strong>
                {result.kind === 'section'
                  ? <span className="documentation-search-crumbs">{result.context}<ChevronRightIcon />{result.title}</span>
                  : <small>{result.context}</small>}
              </span>
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

export interface DocumentationSearchResult {
  /** Route with the section anchor already applied, and the list key. */
  href: string
  kind: 'page' | 'section'
  title: string
  /** Second line: the page description, or the owning page for a section. */
  context: string
}

interface PreparedSearchHeading {
  heading: DocumentationHeading
  normalized: string
}

interface PreparedSearchEntry {
  entry: DocumentationSearchEntry
  title: string
  headings: PreparedSearchHeading[]
  headingText: string
  haystack: string
}

function prepareSearchIndex(index: DocumentationSearchEntry[]): PreparedSearchEntry[] {
  return index.map((entry) => ({
    entry,
    title: normalizeSearch(entry.title),
    headings: entry.headings.map((heading) => ({ heading, normalized: normalizeSearch(heading.text) })),
    headingText: normalizeSearch(entry.headings.map((heading) => heading.text).join(' ')),
    haystack: normalizeSearch(`${entry.description ?? ''} ${entry.text}`),
  }))
}

function rankSearch(index: PreparedSearchEntry[], query: string): DocumentationSearchResult[] {
  const normalized = normalizeSearch(query)
  if (!normalized) return []
  const tokens = normalized.split(' ').filter(Boolean)
  const scored: Array<{ result: DocumentationSearchResult; score: number; route: string }> = []
  for (const { entry, title, headings, headingText, haystack } of index) {
    let score = title === normalized ? 180 : title.startsWith(normalized) ? 110 : title.includes(normalized) ? 75 : 0
    if (headingText.includes(normalized)) score += 55
    for (const token of tokens) {
      if (title.includes(token)) score += 24
      else if (headingText.includes(token)) score += 14
      else if (haystack.includes(token)) score += 5
      else score -= 18
    }
    if (score > 0) {
      scored.push({
        route: entry.route,
        score,
        result: {
          href: entry.route,
          kind: 'page',
          title: entry.title,
          context: entry.description ?? entry.text.slice(0, 150),
        },
      })
    }
    for (const { heading, normalized: headingNormalized } of headings) {
      // Deliberately below an exact page-title hit so pages still lead.
      let sectionScore = headingNormalized === normalized
        ? 120
        : headingNormalized.startsWith(normalized) ? 80 : headingNormalized.includes(normalized) ? 60 : 0
      if (sectionScore === 0) {
        for (const token of tokens) if (headingNormalized.includes(token)) sectionScore += 18
      }
      if (sectionScore <= 0) continue
      scored.push({
        route: `${entry.route}#${heading.id}`,
        score: sectionScore,
        result: {
          href: `${entry.route}#${heading.id}`,
          kind: 'section',
          title: heading.text,
          context: entry.title,
        },
      })
    }
  }
  return scored
    .sort((left, right) => right.score - left.score || left.route.localeCompare(right.route))
    .slice(0, 10)
    .map((item) => item.result)
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
