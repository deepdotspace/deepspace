/**
 * Client-error ingestion route (opt-in) — the Worker half of client-side
 * error reporting.
 *
 * Mount it in your app Worker with a single line:
 *
 *   import { registerClientErrorRoute } from 'deepspace/worker'
 *   registerClientErrorRoute(app)   // BEFORE the app.all('/_deepspace/*') proxy
 *
 * Then, in the browser, `installClientErrorReporter()` (from 'deepspace')
 * forwards uncaught errors here. The handler runs in the app's OWN Worker, so
 * the `console.error` it emits is tagged by Cloudflare with this app's id —
 * meaning a browser can only ever write to its own app's log stream, never
 * another tenant's or the platform's. Reports then surface in `deepspace logs`
 * (and the dashboard) tagged `CLIENT`.
 *
 * Anonymous by design (logged-out visitors hit client errors too), so the
 * defenses are size caps (normalizeClientErrorReport) + a best-effort
 * per-isolate throttle. It never blocks the page: it returns 204 and swallows
 * work quickly.
 */

import type { Hono } from 'hono'
import {
  CLIENT_ERROR_PATH,
  clientErrorToLogLine,
  normalizeClientErrorReport,
} from '../shared/client-errors'

// Per-isolate fixed-window throttle. Best-effort (each isolate counts on its
// own) — enough to blunt a page stuck in an error loop or a malicious flood
// from inflating the app owner's Workers Logs. A DO-backed limiter is the
// follow-up if this proves too coarse.
const THROTTLE_WINDOW_MS = 1000
const THROTTLE_MAX = 20
let windowStart = 0
let windowCount = 0

// The route is anonymous and runs in the app's own isolate, so an unbounded
// `.json()` is an OOM vector — reject oversized bodies before buffering.
const MAX_BODY_BYTES = 64 * 1024

export function shouldThrottleClientError(now: number = Date.now()): boolean {
  if (now - windowStart >= THROTTLE_WINDOW_MS) {
    windowStart = now
    windowCount = 0
  }
  windowCount += 1
  return windowCount > THROTTLE_MAX
}

/** Test hook — throttle state is module-global by design. */
export function resetClientErrorThrottle(): void {
  windowStart = 0
  windowCount = 0
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Handle one client-error report. Framework-agnostic — pass a raw `Request`.
 * Returns 204 on success, 400 on a malformed/empty body, 429 when throttled.
 */
export async function handleClientErrorReport(request: Request): Promise<Response> {
  // Defense-in-depth against cross-origin floods: the reporter always POSTs
  // same-origin, so reject a browser-declared cross-site/same-site fetch (the
  // latter blocks a sibling *.app.space app). Absent (non-browser / older
  // browsers) is allowed — the throttle + caps below are the backstop there.
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') {
    return new Response(null, { status: 403 })
  }

  if (shouldThrottleClientError()) {
    return new Response(null, { status: 429, headers: { 'Retry-After': '1' } })
  }

  // Reject an oversized body before buffering it. Content-Length may be absent
  // on a chunked upload; those stay bounded by CF's request limits + the throttle.
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return jsonResponse({ error: 'payload_too_large' }, 413)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400)
  }

  const report = normalizeClientErrorReport(body)
  if (!report) return jsonResponse({ error: 'invalid_report' }, 400)

  // The one write into Workers Logs. Marker-prefixed so the platform reader
  // tags it source:'client'. Single string arg — CF stores it as the message.
  console.error(clientErrorToLogLine(report))
  return new Response(null, { status: 204 })
}

/**
 * Register `POST /_deepspace/client-errors` on your Hono app. Mount it BEFORE
 * the `app.all('/_deepspace/*')` proxy so the specific route wins the match.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerClientErrorRoute(app: Hono<any, any, any>): void {
  app.post(CLIENT_ERROR_PATH, (c) => handleClientErrorReport(c.req.raw))
}
