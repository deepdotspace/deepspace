/**
 * `deepspace logs` wire DTO — the single source of truth for the whitelisted
 * shape the platform telemetry reader emits and every consumer reads, plus
 * the one plain-text rendering of it (`logEventText`).
 *
 * The producer is `platform/deploy-worker/src/lib/workers-logs.ts` (which
 * rebuilds each event field-by-field from a raw Cloudflare row — see the
 * security invariant there). The consumers are the CLI tail
 * (`cli/commands/logs.ts`), the dashboard Logs panel
 * (`apps/dashboard/src/lib/apps.ts`), and the e2e whitelist assertion
 * (`tests/e2e/tests/logs.spec.ts`). This module used to be hand-mirrored in
 * all four places, and the copies drifted for real: a field addition (the
 * since-removed `source`) landed in three of them and missed the e2e
 * whitelist. It now lives here once and they import it.
 *
 * Isomorphic — no DOM, no Hono, no platform types — so it re-exports cleanly
 * from both `deepspace` (client) and `deepspace/worker` and is safe to import
 * from the private deploy-worker.
 */

export const LOG_LEVELS = ['debug', 'log', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/** One log / request / exception event, rebuilt field-by-field from a CF row. */
export interface AppLogEvent {
  /** `$metadata.id` — unique per event; the client's dedupe key. */
  id: string
  /** Unix ms. */
  timestamp: number
  level: LogLevel
  eventType: 'log' | 'request' | 'exception' | 'other'
  message: string
  /**
   * The runtime's verdict on the invocation (`ok`, `exception`, `exceededCpu`,
   * `canceled`, …) — present on `request` and other invocation-summary events
   * only, never on a `log` line. It says whether the Worker RETURNED, not
   * whether the app succeeded: an action that throws inside the app's own
   * error handling and answers 500 is `ok` here. Triage failures on
   * `request.status`, `level`, and `eventType === 'exception'` (an exception
   * that escaped the Worker), not on `outcome !== 'ok'` alone.
   */
  outcome?: string
  request?: { method: string; path: string; status?: number }
  /**
   * The exception that ESCAPED the Worker (`eventType: 'exception'`). An
   * error the app catches and `console.error`s is a plain `log` line — and
   * the Workers runtime renders a logged Error OBJECT as its stack frames
   * without the message, so render it through `loggableError(err)` (below):
   * message first, bounded cause chain, capped at the reader's budget.
   */
  exception?: { name: string; message: string; stack?: string }
}

export interface AppLogsResponse {
  /** Ascending by timestamp (CF returns newest-first; the reader flips). */
  events: AppLogEvent[]
  /** Max event timestamp in ms — pass back as `since` to poll; null when empty. */
  cursor: number | null
  /** True when the window returned `limit` events (older events were cut). */
  truncated: boolean
  pollIntervalMs: number
}

/**
 * Runtime tuple of every key a whitelisted `AppLogEvent` may carry — the
 * canonical whitelist the e2e suite mirrors when asserting no event leaks a key
 * outside this set. The two type-level assertions below fail compilation if
 * this tuple and the `AppLogEvent` interface disagree in either direction, so
 * adding an interface field forces a matching key here.
 *
 * NOTE: the e2e spec keeps its OWN copy of this set (it can't import the SDK —
 * `@deepspace/e2e` has no `deepspace` dependency), kept in step by a comment,
 * not by these compile-time guards. So this tuple hardens the code copies
 * (deploy-worker/CLI/dashboard, which import it), while the e2e mirror remains a
 * knowingly-accepted duplicate.
 */
export const APP_LOG_EVENT_KEYS = [
  'id',
  'timestamp',
  'level',
  'eventType',
  'message',
  'outcome',
  'request',
  'exception',
] as const

export type AppLogEventKey = (typeof APP_LOG_EVENT_KEYS)[number]

// Compile-time guard: `APP_LOG_EVENT_KEYS` and `keyof AppLogEvent` list the
// same keys. If either drifts, one of these aliases resolves to `never` and
// `tsc` errors on the assignment.
type _KeysCoverInterface = AppLogEventKey extends keyof AppLogEvent ? true : never
type _InterfaceCoversKeys = keyof AppLogEvent extends AppLogEventKey ? true : never
const _assertKeysMatch: [_KeysCoverInterface, _InterfaceCoversKeys] = [true, true]
void _assertKeysMatch

/**
 * One event → its plain-text body: what the event *says*, with no colors,
 * tags, timestamps, or stack frames — those belong to each renderer. Shared
 * by the CLI line formatter and the dashboard rows (which also use it as the
 * search corpus), so "does this event mention X" means the same thing in
 * both.
 */
export function logEventText(e: AppLogEvent): string {
  if (e.eventType === 'exception' && e.exception) {
    const where = e.request ? ` — ${e.request.method} ${e.request.path}` : ''
    return `${e.exception.name}: ${e.exception.message}${where}`
  }
  if (e.eventType === 'request' && e.request) {
    const status = e.request.status !== undefined ? ` ${e.request.status}` : ''
    const outcome = e.outcome && e.outcome !== 'ok' ? ` (${e.outcome})` : ''
    return `${e.request.method} ${e.request.path}${status}${outcome}`
  }
  return e.message
}

/**
 * An error as a string that survives Workers Logs ingestion. The telemetry
 * pipeline serializes a logged Error OBJECT down to its stack FRAMES — the
 * `Error: <message>` first line is dropped (observed 2026-08; Hono's default
 * handler does exactly `console.error(err)`, which is why an uncaught route
 * error showed up in `deepspace logs` as bare frames). A STRING passes
 * through verbatim. V8 stacks already open with `Error: <message>` (prefix
 * test, not substring); frames-only stacks get the header prepended; a
 * missing stack degrades to the header alone. `cause` chains and
 * `AggregateError.errors` are walked (bounded, cycle-safe) because the only
 * actionable text of the most common Workers error — `TypeError: fetch
 * failed` — lives there. Rendering is budgeted at every step: pieces are
 * sliced and the walk stops once MAX_LOG_TEXT_LENGTH is reached (error text
 * is often request-derived, and unbounded intermediates measured >100 MB on
 * hostile chains), and the final string never exceeds the budget the reader
 * truncates at (a call-site prefix can still push a full-budget line past
 * it — the reader re-cuts with the same `truncateLogText`). Never throws: a
 * hostile NODE (throwing getters, revoked Proxies, null-prototype
 * throwables) degrades to a tag IN PLACE so the rest of the render — the
 * part with the actionable message — survives. So:
 * `console.error(loggableError(err))`, never `console.error(err)`.
 */
export function loggableError(err: unknown): string {
  try {
    return truncateLogText(renderError(err, 0))
  } catch {
    return tagOf(err)
  }
}

/**
 * Cut a string to `MAX_LOG_TEXT_LENGTH` INCLUDING the truncation marker —
 * the one truncation for log text, shared by the write side (`loggableError`)
 * and the read side (the deploy-worker reader's per-field cap), so the two
 * cannot drift. Steps back off a high surrogate so the cut never leaves a
 * lone half of a surrogate pair in the log line.
 */
export function truncateLogText(s: string): string {
  if (s.length <= MAX_LOG_TEXT_LENGTH) return s
  let cut = MAX_LOG_TEXT_LENGTH - TRUNCATION_MARKER.length
  const last = s.charCodeAt(cut - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1
  return s.slice(0, cut) + TRUNCATION_MARKER
}

/** The one write-side budget for rendered error text, matching the reader's
 *  per-field cap (the deploy-worker's log reader imports this so the two
 *  sides cannot drift). The rendered string INCLUDING any truncation marker
 *  stays within it. */
export const MAX_LOG_TEXT_LENGTH = 8 * 1024

const TRUNCATION_MARKER = '… [truncated]'
const MAX_CAUSE_DEPTH = 4

/** The last-resort rendering — even `Object.prototype.toString` throws on a
 *  revoked Proxy or a hostile `Symbol.toStringTag`. */
function tagOf(err: unknown): string {
  try {
    return Object.prototype.toString.call(err)
  } catch {
    return '[unloggable error]'
  }
}

function renderError(err: unknown, depth: number): string {
  // Even `instanceof` throws on a revoked Proxy (its [[GetPrototypeOf]] is
  // gone) — outside a try it would unwind into the PARENT's catch and take
  // the remaining siblings with it instead of degrading just this node.
  let isError: boolean
  try {
    isError = err instanceof Error
  } catch {
    return tagOf(err)
  }
  if (!isError) {
    try {
      return String(err).slice(0, MAX_LOG_TEXT_LENGTH + 1)
    } catch {
      return tagOf(err)
    }
  }
  const e = err as Error
  // Piece slices keep ONE char beyond the budget so "content exactly at the
  // budget after slicing" still reads as over-budget at the top level and
  // gets the truncation marker — a silent cut would hide that content is
  // missing.
  let out: string
  try {
    const stack = typeof e.stack === 'string' ? e.stack : undefined
    // Empty message → bare `name` header: V8 writes such stacks as
    // `TypeError\n    at …` (no colon), so the prefix test still recognizes
    // them, while a frames-only stack still gets the name prepended instead
    // of losing it.
    const head = (e.message ? `${e.name}: ${e.message}` : `${e.name}`).slice(
      0,
      MAX_LOG_TEXT_LENGTH + 1,
    )
    if (!stack) out = head
    else if (stack.startsWith(head)) out = stack.slice(0, MAX_LOG_TEXT_LENGTH + 1)
    else out = `${head}\n${stack.slice(0, MAX_LOG_TEXT_LENGTH + 1)}`
  } catch {
    // A bad node degrades IN PLACE — its siblings and parents keep rendering.
    return tagOf(err)
  }
  try {
    if (e instanceof AggregateError && Array.isArray(e.errors)) {
      if (depth < MAX_CAUSE_DEPTH) {
        for (const sub of e.errors.slice(0, MAX_CAUSE_DEPTH)) {
          // Budget exhausted with siblings unrendered: say so. At exactly
          // MAX a bare return would read as a complete line (the top-level
          // marker only fires ABOVE the budget); overshooting here is fine —
          // the top level re-cuts and re-marks.
          if (out.length >= MAX_LOG_TEXT_LENGTH) return out + '\n… [cause chain truncated]'
          out += `\ncaused by: ${renderError(sub, depth + 1)}`
        }
        if (e.errors.length > MAX_CAUSE_DEPTH) {
          out += `\n… [${e.errors.length - MAX_CAUSE_DEPTH} more errors]`
        }
      } else {
        out += '\n… [cause chain truncated]'
      }
    }
    const cause = e.cause
    if (cause != null) {
      if (depth >= MAX_CAUSE_DEPTH) {
        if (!out.endsWith('… [cause chain truncated]')) out += '\n… [cause chain truncated]'
      } else if (out.length < MAX_LOG_TEXT_LENGTH) {
        out += `\ncaused by: ${renderError(cause, depth + 1)}`
      } else {
        out += '\n… [cause chain truncated]'
      }
    }
  } catch {
    // A hostile errors/cause getter (or an unrenderable nested node that
    // slipped every local guard) must not discard the message above it.
    out += '\n… [cause chain unrenderable]'
  }
  return out
}
