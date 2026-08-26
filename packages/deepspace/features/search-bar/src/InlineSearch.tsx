import type { ReactNode } from 'react'
import { EmptyState, SearchInput, cn } from '@/components/ui'
import { Loader2 } from 'lucide-react'
import { getHighlightedParts } from './search-model'

export interface SearchItem {
  id: string
  title: string
  subtitle?: string
  description?: string
  meta?: ReactNode
  disabled?: boolean
}

export interface InlineSearchProps<T extends SearchItem = SearchItem> {
  query: string
  onQueryChange: (query: string) => void
  items: T[]
  onSelect: (item: T) => void
  placeholder?: string
  label?: string
  loading?: boolean
  error?: string | null
  emptyTitle?: string
  className?: string
}

/** A small, controlled search input and result list for one page section. */
export function InlineSearch<T extends SearchItem = SearchItem>({
  query,
  onQueryChange,
  items,
  onSelect,
  placeholder = 'Search...',
  label,
  loading = false,
  error = null,
  emptyTitle = 'No matches',
  className,
}: InlineSearchProps<T>) {
  return (
    <section className={cn('space-y-2', className)}>
      {label && <label className="text-sm font-medium text-foreground">{label}</label>}
      <SearchInput
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onClear={() => onQueryChange('')}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
      />

      {loading ? (
        <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Searching...
        </div>
      ) : error ? (
        <p role="alert" className="p-3 text-sm text-destructive">
          {error}
        </p>
      ) : items.length === 0 ? (
        <EmptyState title={emptyTitle} description="Try another search term." />
      ) : (
        <ul className="max-h-80 overflow-y-auto rounded-lg border border-border bg-card">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                disabled={item.disabled}
                onClick={() => onSelect(item)}
                className="flex w-full items-start justify-between gap-3 border-b border-border p-3 text-left last:border-b-0 hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">
                    <HighlightedText text={item.title} query={query} />
                  </span>
                  {item.subtitle && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      <HighlightedText text={item.subtitle} query={query} />
                    </span>
                  )}
                  {item.description && (
                    <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">
                      {item.description}
                    </span>
                  )}
                </span>
                {item.meta}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  return getHighlightedParts(text, query).map((part, index) =>
    part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
  )
}
