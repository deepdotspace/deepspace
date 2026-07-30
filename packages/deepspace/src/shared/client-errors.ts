/**
 * Client-side error reporting — shared contract.
 *
 * Browser JS errors never invoke the app's Worker, so they never reach
 * Workers Logs and are invisible to `deepspace logs`. The opt-in reporter
 * (`installClientErrorReporter`, client entry) forwards them to the app's own
 * Worker via `registerClientErrorRoute` (worker entry), which `console.error`s
 * a marker-prefixed envelope. The platform log reader recognises the marker
 * and tags the event `source: 'client'`.
 *
 * This module is isomorphic — no DOM, no Hono — so both halves import the
 * exact same marker, caps, and normaliser and can never drift.
 */

/**
 * Prefix the Worker route prepends before JSON-stringifying a report into a
 * single `console.error` line. The platform mapper
 * (platform/deploy-worker/src/lib/workers-logs.ts) detects this prefix to set
 * `source: 'client'`. Deliberately distinctive so an ordinary app log is
 * vanishingly unlikely to collide. The marker is added SERVER-SIDE by the app
 * Worker — a browser cannot forge it onto a genuine server log.
 *
 * The platform copy is kept in sync by a drift test; if you change this
 * string, that test fails until the platform const matches.
 */
export const CLIENT_LOG_MARKER = '[deepspace:client-error]'

/** Same-origin path the reporter POSTs to and the route registers. */
export const CLIENT_ERROR_PATH = '/_deepspace/client-errors'

/**
 * Per-field caps on the browser-supplied report. These bound the payload the
 * reporter sends and the route logs — they are NOT a hard serialized-size
 * guarantee: JSON escaping (a control char → `\u00XX`, 6×) and multibyte text
 * can inflate the serialized line several-fold (a maxed adversarial envelope is
 * ~24 KB). That's fine — Cloudflare Workers Logs truncates a log event at
 * ~256 KB (bytes), so even the worst case survives intact and re-parses on
 * read. The platform reader (`workers-logs.ts`) then caps each surfaced field
 * (message/stack) at 8 KB *after* parsing.
 */
export const CLIENT_ERROR_CAPS = {
  message: 1024,
  stack: 4096,
  name: 256,
  url: 512,
} as const

export type ClientErrorKind = 'error' | 'unhandledrejection' | 'react'

/** A sanitized, capped browser-error report — the wire + log-line payload. */
export interface ClientErrorReport {
  kind: ClientErrorKind
  message: string
  name?: string
  stack?: string
  /** Page URL where it fired (href or the script filename). */
  url?: string
  line?: number
  col?: number
}

function capText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.length > max ? value.slice(0, max) : value
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Validate + cap an untrusted report shape into a `ClientErrorReport`, or
 * `null` when there's nothing useful to log. Used on BOTH ends: the browser
 * caps before sending, and the Worker route re-normalises defensively — it
 * never trusts the posted body, mirroring the platform reader's field-by-field
 * whitelist philosophy.
 */
export function normalizeClientErrorReport(raw: unknown): ClientErrorReport | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>

  const kind: ClientErrorKind =
    o.kind === 'unhandledrejection' || o.kind === 'react' ? o.kind : 'error'
  const message = capText(o.message, CLIENT_ERROR_CAPS.message) ?? ''
  const name = capText(o.name, CLIENT_ERROR_CAPS.name)
  const stack = capText(o.stack, CLIENT_ERROR_CAPS.stack)
  const url = capText(o.url, CLIENT_ERROR_CAPS.url)
  const line = finiteNumber(o.line)
  const col = finiteNumber(o.col)

  // Nothing actionable — drop it (Worker route → 400).
  if (!message && !stack) return null

  const report: ClientErrorReport = { kind, message: message || (name ?? 'Error') }
  if (name) report.name = name
  if (stack) report.stack = stack
  if (url) report.url = url
  if (line !== undefined) report.line = line
  if (col !== undefined) report.col = col
  return report
}

/** The exact single-string line the Worker route writes to Workers Logs. */
export function clientErrorToLogLine(report: ClientErrorReport): string {
  return `${CLIENT_LOG_MARKER} ${JSON.stringify(report)}`
}
