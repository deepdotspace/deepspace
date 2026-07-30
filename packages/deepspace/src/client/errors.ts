/**
 * Client-side error reporter (opt-in) — the browser half of client-side error
 * reporting.
 *
 *   // src/main.tsx (or your root)
 *   import { installClientErrorReporter } from 'deepspace'
 *   installClientErrorReporter()
 *
 * Hooks `window` 'error' + 'unhandledrejection' and forwards each to the app's
 * own Worker (see `registerClientErrorRoute` in 'deepspace/worker'), where it
 * lands in Workers Logs and shows up in `deepspace logs` tagged CLIENT.
 *
 * Best-effort by contract: it dedupes, caps how many it sends per page load,
 * and NEVER throws — a broken reporter must not break the app it watches.
 */

import { CLIENT_ERROR_PATH, normalizeClientErrorReport } from '../shared/client-errors'
import type { ClientErrorReport } from '../shared/client-errors'

export interface ClientErrorReporterOptions {
  /** Override the ingestion path (default `/_deepspace/client-errors`). */
  endpoint?: string
  /** Max reports sent per page load — a runaway loop can't flood (default 50). */
  maxReports?: number
}

// Strip query + fragment from a URL before it leaves the browser — a page href
// or script filename may carry tokens the app put in its own URL, and those
// should never be persisted in the platform's account-wide log store. Returns
// origin + pathname only. Never throws.
function stripQuery(u: string | undefined): string | undefined {
  if (!u) return undefined
  try {
    const parsed = new URL(u, window.location?.href)
    return parsed.origin + parsed.pathname
  } catch {
    return undefined
  }
}

// Fire-and-forget POST. Same-origin, so the session cookie rides along for
// logged-in users; anonymous visitors are accepted too. keepalive lets a
// report survive the page unloading right after the error.
function post(endpoint: string, report: ClientErrorReport): void {
  try {
    void fetch(endpoint, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    }).catch(() => {})
  } catch {
    // A reporter must never throw — swallow everything.
  }
}

// Module-global so a repeated install() call (against the same cached module
// instance) doesn't double-report. Note: a full Vite HMR reload that
// re-evaluates this module resets it — wire `import.meta.hot.dispose(uninstall)`
// if you install inside an HMR-reloaded module.
let installed = false

/**
 * Install global handlers that forward uncaught browser errors to the app's
 * Worker. No-op outside a browser. Returns an uninstall function.
 */
export function installClientErrorReporter(
  options: ClientErrorReporterOptions = {},
): () => void {
  if (typeof window === 'undefined' || installed) return () => {}
  installed = true

  const endpoint = options.endpoint ?? CLIENT_ERROR_PATH
  const maxReports = options.maxReports ?? 50
  const seen = new Set<string>()
  let sent = 0

  const send = (raw: Record<string, unknown>): void => {
    const report = normalizeClientErrorReport(raw)
    if (!report) return
    const key = `${report.kind}:${report.name ?? ''}:${report.message}`
    if (seen.has(key)) return
    // Cap BEFORE recording, so `seen` can't grow past the cap on a loop that
    // throws distinct errors (network is capped either way; this bounds memory).
    if (sent >= maxReports) return
    seen.add(key)
    sent += 1
    post(endpoint, report)
  }

  // The field extraction itself must not throw (a hostile `reason` can have a
  // throwing `toString`/getter or a Proxy trap) — the whole handler is guarded.
  const onError = (event: ErrorEvent): void => {
    try {
      const err = event.error as Error | undefined
      send({
        kind: 'error',
        name: err?.name,
        message: err?.message ?? event.message,
        stack: err?.stack,
        url: stripQuery(event.filename || window.location?.href),
        line: event.lineno,
        col: event.colno,
      })
    } catch {
      // never throw
    }
  }

  const onRejection = (event: PromiseRejectionEvent): void => {
    try {
      const reason: unknown = event.reason
      const isError = reason instanceof Error
      send({
        kind: 'unhandledrejection',
        name: isError ? reason.name : undefined,
        message: isError ? reason.message : String(reason),
        stack: isError ? reason.stack : undefined,
        url: stripQuery(window.location?.href),
      })
    } catch {
      // never throw
    }
  }

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)

  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    installed = false
  }
}

/**
 * Manually report a caught error — e.g. from a React error boundary's
 * `componentDidCatch`. No-op outside a browser; never throws. Unlike the
 * auto-installed handlers this has no client-side dedupe/cap — it relies on the
 * ingestion route's per-isolate throttle — so call it from boundaries (which
 * unmount rather than loop), not a hot path.
 */
export function reportClientError(
  error: unknown,
  options: ClientErrorReporterOptions & { componentStack?: string } = {},
): void {
  if (typeof window === 'undefined') return
  try {
    const isError = error instanceof Error
    const report = normalizeClientErrorReport({
      kind: 'react',
      name: isError ? error.name : undefined,
      message: isError ? error.message : String(error),
      stack: (isError ? error.stack : undefined) ?? options.componentStack,
      url: stripQuery(window.location?.href),
    })
    if (!report) return
    post(options.endpoint ?? CLIENT_ERROR_PATH, report)
  } catch {
    // never throw
  }
}
