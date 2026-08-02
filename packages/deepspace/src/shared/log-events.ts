/**
 * `deepspace logs` wire DTO — the single source of truth for the whitelisted
 * shape the platform telemetry reader emits and every consumer reads.
 *
 * The producer is `platform/deploy-worker/src/lib/workers-logs.ts` (which
 * rebuilds each event field-by-field from a raw Cloudflare row — see the
 * security invariant there). The consumers are the CLI tail
 * (`cli/commands/logs.ts`), the dashboard Logs panel
 * (`apps/dashboard/src/lib/apps.ts`), and the e2e whitelist assertion
 * (`tests/e2e/tests/logs.spec.ts`). This module used to be hand-mirrored in
 * all four places; `source` was added to three of them and missed in the
 * e2e whitelist, so it now lives here once and they import it.
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
   * Present (= `'client'`) only for a browser-forwarded error the app's own
   * Worker re-logged via `registerClientErrorRoute`. Absent means the log was
   * emitted server-side — there is no explicit `'server'` value, so consumers
   * branch on `source === 'client'`, never on a truthy/other check.
   */
  source?: 'client'
  /** Invocation outcome (`ok`, `exception`, `exceededCpu`, …) when present. */
  outcome?: string
  request?: { method: string; path: string; status?: number }
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
  'source',
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
