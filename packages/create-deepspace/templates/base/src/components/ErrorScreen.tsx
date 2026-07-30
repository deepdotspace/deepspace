/**
 * Error decoding + a friendly error screen.
 *
 * Production React replaces error text with a numeric code and a docs link
 * (e.g. `Minified React error #310`), so a developer whose app crashes in a
 * deployed build sees only the number. `decodeReactError` turns that number
 * back into a plain-English explanation; `ErrorScreen` renders it. The most
 * common offenders are the hook-order errors (#300 / #310), which almost
 * always mean a hook was placed after an early `return`.
 *
 * Self-contained on purpose: it renders as the root error boundary, replacing
 * the app shell, so it must not depend on app providers or any component
 * library. It reads its colors from the active theme's CSS variables.
 */

import { AlertTriangle, RefreshCw } from 'lucide-react'

export interface DecodedReactError {
  code: number
  title: string
  explanation: string
  hint: string
  docsUrl: string
}

/**
 * Friendly text for the React errors apps actually hit. Kept deliberately
 * small — any other code still decodes to a generic, linkable result.
 */
const REACT_ERROR_TABLE: Record<number, Omit<DecodedReactError, 'code' | 'docsUrl'>> = {
  300: {
    title: 'A component changed how many hooks it runs',
    explanation: 'This component called fewer hooks than it did on its previous render.',
    hint: 'Almost always an early return placed above a hook. Move every hook (useState, useEffect, useQuery, …) above any conditional return so the same hooks run in the same order on every render.',
  },
  310: {
    title: 'A component changed how many hooks it runs',
    explanation: 'This component called more hooks than it did on its previous render.',
    hint: 'Almost always an early return placed above a hook. Move every hook (useState, useEffect, useQuery, …) above any conditional return so the same hooks run in the same order on every render.',
  },
  301: {
    title: 'Too many re-renders',
    explanation: 'React hit its render limit because the component updated state while rendering, which triggers an infinite render loop.',
    hint: 'Don’t call setState (or a mutation) directly in the render body. Move it into an event handler or an effect with the right dependencies.',
  },
  321: {
    title: 'A hook was called in an invalid place',
    explanation: 'Hooks can only be called at the top level of a function component or another hook.',
    hint: 'Move the hook out of any condition, loop, callback, or plain (non-component) function. This can also mean two copies of React are installed.',
  },
}

/** Pull a React error code out of a message, whether minified, URL, or legacy form. */
function extractReactErrorCode(message: string): number | null {
  const patterns = [/react\.dev\/errors\/(\d+)/, /invariant=(\d+)/, /Minified React error #(\d+)/]
  for (const re of patterns) {
    const match = message.match(re)
    if (match) return Number(match[1])
  }
  return null
}

function errorMessage(error: unknown): string | null {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return null
}

/**
 * Decode a (possibly minified) React error into a friendly explanation, or
 * `null` if it isn't a recognizable React error — in which case the caller
 * should just show the raw message.
 */
export function decodeReactError(error: unknown): DecodedReactError | null {
  const message = errorMessage(error)
  if (!message) return null
  const code = extractReactErrorCode(message)
  if (code == null) return null

  const known = REACT_ERROR_TABLE[code]
  return {
    code,
    docsUrl: `https://react.dev/errors/${code}`,
    title: known?.title ?? `React error #${code}`,
    explanation: known?.explanation ?? 'React stopped rendering because of an error.',
    hint:
      known?.hint ??
      'Run the app in development (npm run dev) to see the full, unminified message and the component that failed.',
  }
}

export interface ErrorScreenProps {
  /** The thrown value, as caught by an error boundary (often non-Error). */
  error: unknown
  /** Recovery action. Defaults to a full page reload. */
  onReset?: () => void
}

export function ErrorScreen({ error, onReset }: ErrorScreenProps) {
  const decoded = decodeReactError(error)
  const rawMessage = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const stack = error instanceof Error ? error.stack : undefined
  const reset = onReset ?? (() => window.location.reload())

  return (
    <div
      data-testid="ds-error-boundary"
      className="flex h-full min-h-[60vh] flex-col items-center justify-center bg-background px-4 py-10 text-foreground"
    >
      <div className="w-full max-w-lg text-center">
        <div className="mb-4 flex justify-center">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="h-6 w-6" aria-hidden />
          </span>
        </div>

        <h1 className="text-lg font-semibold tracking-tight">
          {decoded?.title ?? 'Something went wrong'}
        </h1>
        {decoded?.explanation && (
          <p className="mt-1.5 text-sm text-muted-foreground">{decoded.explanation}</p>
        )}

        {decoded?.hint && (
          <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-left">
            <p className="text-sm font-medium text-warning">How to fix</p>
            <p className="mt-1 text-sm text-muted-foreground">{decoded.hint}</p>
          </div>
        )}

        {rawMessage && (
          <pre className="mt-4 overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2 text-left text-xs text-muted-foreground">
            {rawMessage}
          </pre>
        )}

        {stack && (
          <details className="mt-2 text-left">
            <summary className="cursor-pointer text-xs text-muted-foreground">Show stack trace</summary>
            <pre className="mt-1 max-h-60 overflow-auto rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {stack}
            </pre>
          </details>
        )}

        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-opacity hover:opacity-90"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Reload
          </button>
          {decoded && (
            <a
              href={decoded.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              React error #{decoded.code} reference
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
