/**
 * deepspace logs
 *
 * Production logs for a deployed app — console output, request summaries,
 * and exceptions — read from Workers Logs through the platform (7-day
 * retention). Defaults to the last 15 minutes; `--follow` keeps polling
 * for new events until Ctrl+C. There is no push channel for
 * dispatch-namespace scripts, so polling IS the tail (the server's
 * `pollIntervalMs` sets the cadence).
 *
 * `--json` emits NDJSON — one event object per line — so agents and pipes
 * get a parseable stream in both one-shot and follow mode (deliberately
 * not the pretty-array shape `apps --json` uses). A truncated page also
 * emits one `{ "type": "meta", "truncated": true }` record (events never
 * carry a `type`, so consumers can branch on it) — otherwise a dropped
 * burst would be invisible to a machine reader.
 *
 * Ingestion lags real time by seconds up to ~1 minute: an empty result
 * right after a request is lag, not absence.
 */

import { displayLines } from '../lib/cli-format'
import { defineCommand } from 'citty'
import { setTimeout as delay } from 'node:timers/promises'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { apiFetch, apiFetchReadWithRetry, ApiError } from '../lib/api'
import { InputError } from '../lib/cli-errors'
import { resolveAppTarget, assertAppTargetResolvable, listApps } from '../lib/app-target'
import { Refusal } from '../lib/command'
import { findAppDir } from '../lib/app-context'
// Whitelisted wire DTO + level set — shared with the platform reader and the
// dashboard (packages/deepspace/src/shared/log-events.ts) so they can't drift.
import {
  LOG_LEVELS,
  logEventText,
  type AppLogEvent,
  type AppLogsResponse,
} from '../../shared/log-events'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_WINDOW_MS = 15 * 60 * 1000
const MIN_POLL_MS = 2500
/**
 * Follow mode re-scans this far back of the last cursor before each poll.
 * Workers Logs ingestion is completion-ordered and lags up to ~1 min, so a
 * slow invocation's earlier-stamped line can arrive AFTER a fast request's
 * later-stamped line already advanced the cursor past it — polling only from
 * `cursor` would drop it permanently. The id dedupe (SeenEvents) discards the
 * re-fetched overlap, so the lag window costs nothing but a slightly larger page.
 *
 * Set above the stated ~60s max lag for margin: an event ingested more than
 * this late is still missed (CF's telemetry API has no ascending drain to
 * recover it), so this shrinks — not eliminates — the drop window.
 */
const FOLLOW_LAG_MS = 90_000

/** Platform log retention; mirrored in the human copy below. */
const LOG_RETENTION_DAYS = 7

/**
 * The page size a follow tail requests. Follow defaults to the max page so a
 * burst between polls is less likely to overflow one page and silently drop its
 * oldest events; an explicit `--limit` still wins. Exported for tests.
 */
export function followInitialLimit(limit: number | undefined, maxLimit: number): number {
  return limit ?? maxLimit
}

/** A follow-poll failure that cannot improve by resending the same request:
 *  the server refused it as malformed (400 — in a live tail that means the
 *  platform stopped accepting a shape it used to, e.g. a removed param) or
 *  auth/authz/absence (401/403/404). Everything else — 429 (the route's own
 *  throttle asks for a retry), 5xx, network — backs off. A 400 used to be
 *  retried forever at max backoff. */
export function fatalFollowStatus(status: number): boolean {
  return [400, 401, 403, 404].includes(status)
}

/**
 * Where the next follow poll starts: `FOLLOW_LAG_MS` before the last cursor,
 * floored at the original window start so a tail never scans before the user's
 * `--since`. Exported for tests.
 */
export function nextPollSince(
  cursor: number,
  floor: number,
  lagMs: number = FOLLOW_LAG_MS,
): number {
  return Math.max(cursor - lagMs, floor)
}

/**
 * `30s` / `15m` / `2h` / `7d` or an ISO timestamp → unix ms. Exported for
 * tests.
 */
export function parseSince(input: string, now: number = Date.now()): number {
  const trimmed = input.trim()
  const rel = /^(\d+)([smhd])$/.exec(trimmed)
  let ts: number
  if (rel) {
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      rel[2] as 's' | 'm' | 'h' | 'd'
    ]
    ts = now - Number(rel[1]) * unit
  } else {
    ts = Date.parse(trimmed)
    if (Number.isNaN(ts)) {
      throw new InputError(
        `Invalid --since "${input}" — use 30s, 15m, 2h, 7d, or an ISO timestamp.`,
        'invalid_since',
      )
    }
  }
  if (now - ts > RETENTION_MS) {
    throw new InputError(
      'Logs are retained for 7 days — --since can reach back at most 7d.',
      'since_out_of_range',
    )
  }
  return ts
}

/**
 * Rolling dedupe window for follow mode. Poll N+1 re-fetches from the last
 * cursor timestamp (inclusive), so events at exactly that millisecond come
 * back again; a bounded id set drops them without assuming server ordering.
 * Exported for tests.
 */
export class SeenEvents {
  private ids = new Set<string>()
  private order: string[] = []
  constructor(private cap = 5000) {}

  /** Returns only the events not seen before, recording them. */
  fresh(events: AppLogEvent[]): AppLogEvent[] {
    const out: AppLogEvent[] = []
    for (const e of events) {
      if (this.ids.has(e.id)) continue
      this.ids.add(e.id)
      this.order.push(e.id)
      out.push(e)
    }
    while (this.order.length > this.cap) {
      this.ids.delete(this.order.shift()!)
    }
    return out
  }
}

// ── Pretty rendering ─────────────────────────────────────────────────────────

const stdoutColor = () => process.stdout.isTTY && !process.env.NO_COLOR
// Status/diagnostic lines go to stderr, so their coloring must gate on
// stderr's TTY-ness — not stdout's, which may be redirected to a file/pipe.
const stderrColor = () => process.stderr.isTTY && !process.env.NO_COLOR
const paint = (code: string, s: string, on: boolean) => (on ? `\x1b[${code}m${s}\x1b[0m` : s)

const LEVEL_STYLE: Record<string, string | null> = {
  error: '31', // red
  warn: '33', // yellow
  debug: '2', // dim
  info: null,
  log: null,
}

function formatTime(ts: number, now: number): string {
  const d = new Date(ts)
  const ref = new Date(now)
  const hms =
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:` +
    `${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`
  if (d.toDateString() === ref.toDateString()) return hms
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${ymd} ${hms}`
}

/** One event → printable line(s). Exported for tests (pass color=false). */
export function formatEvent(e: AppLogEvent, color: boolean, now: number = Date.now()): string {
  const time = paint('2', formatTime(e.timestamp, now), color)

  // The un-styled body text is shared with the dashboard (logEventText);
  // this formatter's own job is tags, color, and stack frames.
  const text = displayLines(logEventText(e))
  let tag: string
  let body: string
  if (e.eventType === 'exception' && e.exception) {
    tag = paint('31', 'ERROR', color)
    body = text
    if (e.exception.stack) {
      // Drop a leading "Name: message" header line (V8 style) so it isn't
      // shown twice — but Cloudflare worker stacks are often frame-only
      // (e.g. "    at fetch (index.js:1:1)") with NO header, so only strip the
      // first line when it actually IS that header. Otherwise we'd eat a frame.
      const lines = e.exception.stack.split('\n')
      const firstIsHeader =
        lines.length > 0 && !/^\s*at\s/.test(lines[0]) && lines[0].includes(e.exception.message)
      const frames = (firstIsHeader ? lines.slice(1) : lines)
        .map((l) => '    ' + l.trim())
        .filter((l) => l.trim().length > 0)
      if (frames.length) body += '\n' + paint('2', displayLines(frames.join('\n')), color)
    }
  } else if (e.eventType === 'request' && e.request) {
    tag = paint('36', 'REQ  ', color)
    body = text
  } else {
    const style = LEVEL_STYLE[e.level]
    tag = (e.level.toUpperCase() + '     ').slice(0, 5)
    if (style) tag = paint(style, tag, color)
    body = style ? paint(style, text, color) : text
  }

  // Every free-text piece above passes through displayLines: an app echoing
  // request-supplied text into its own console lines would otherwise let a
  // third party plant ANSI escapes (`ESC[2K\r` repaints the developer's
  // terminal with text of the visitor's choosing). Escaped per PIECE rather
  // than at the end: painting happens on the way out, and escaping after it
  // would turn our own colour codes into literal `\x1b[31m`.
  return `${time} ${tag} ${body}`
}

// ── Command ──────────────────────────────────────────────────────────────────

// node:timers/promises so follow mode can abort the inter-poll wait on
// Ctrl+C; rejects with an AbortError when the signal fires.
const sleep = (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal })

export default defineCommand({
  meta: {
    name: 'logs',
    description: 'Show production logs for a deployed app (add --follow to tail)',
  },
  args: {
    app: {
      type: 'string',
      alias: 'a',
      description: 'App id or name (default: DEEPSPACE_APP_ID from the nearest wrangler.toml)',
      required: false,
    },
    env: {
      type: 'string',
      alias: 'e',
      description: 'wrangler.toml [env.<name>] slot — reads that env’s own app id',
      required: false,
    },
    follow: {
      type: 'boolean',
      alias: 'f',
      description: 'Keep polling for new logs until Ctrl+C (~3s cadence)',
      default: false,
    },
    since: {
      type: 'string',
      description: 'Window start: 30s, 15m, 2h, 24h, 7d, or an ISO timestamp (default 15m)',
      required: false,
    },
    level: {
      type: 'string',
      description: `Only events at a level: ${LOG_LEVELS.join(', ')}`,
      required: false,
    },
    search: {
      type: 'string',
      description: 'Only events whose rendered text contains this (case-insensitive)',
      required: false,
    },
    limit: {
      type: 'string',
      description: 'Max events per fetch (default 100, max 500)',
      required: false,
    },
    json: {
      type: 'boolean',
      description: 'Emit NDJSON — one event object per line (for agents/pipes)',
      default: false,
    },
  },
  async run({ args }) {
    const envArg = args.env as string | undefined
    assertAppTargetResolvable(args.app, { wranglerEnv: envArg })
    const token = await ensureToken()
    const appId = await resolveAppTarget(DEPLOY_URL, token, args.app, { wranglerEnv: envArg })

    if (args.level && !(LOG_LEVELS as readonly string[]).includes(args.level)) {
      throw new InputError(
        `Invalid --level "${args.level}". Use: ${LOG_LEVELS.join(', ')}`,
        'invalid_level',
      )
    }
    let limit: number | undefined
    if (args.limit !== undefined) {
      limit = Number(args.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new InputError(
          'Invalid --limit — expected an integer between 1 and 500.',
          'invalid_limit',
        )
      }
    }

    const initialSince = args.since ? parseSince(args.since) : Date.now() - DEFAULT_WINDOW_MS
    const windowLabel = args.since?.trim() || '15m'

    // An app that has never been deployed has no logs and never will until it
    // is: "no logs in the last 15m" would be true and useless. The registry
    // row (`deployedAt`) is the same fact `status` reports; an app the listing
    // cannot see (an admin acting on another account's app) is not evidence
    // of anything, so only a visible never-deployed row refuses.
    const registryRow = (await listApps(DEPLOY_URL, token)).find((app) => app.appId === appId)
    if (registryRow && registryRow.deployedAt === null) {
      // The deploy is executable only from the app's own checkout — which is
      // where we are exactly when the id came from the surrounding wrangler.toml.
      const appDir = args.app === undefined ? findAppDir() : null
      throw new Refusal(
        `${appId} has never been deployed, so it has no logs. Deploy it first (\`deepspace deploy\`), then read its logs.`,
        'app_not_deployed',
        appDir
          ? {
              action: {
                cwd: appDir,
                argv: ['deepspace', 'deploy', ...(envArg ? ['--env', envArg] : [])],
              },
            }
          : {},
      )
    }

    // Server clamp; used as the follow-mode default so a burst between polls is
    // less likely to overflow one page (see the truncation note below).
    const MAX_LIMIT = 500
    const followLimit = followInitialLimit(limit, MAX_LIMIT)

    const fetchPage = async (
      since: number,
      pageLimit: number | undefined,
      token: string,
      signal?: AbortSignal,
    ): Promise<AppLogsResponse> => {
      const params = new URLSearchParams({ since: String(since) })
      if (pageLimit !== undefined) params.set('limit', String(pageLimit))
      if (args.level) params.set('level', args.level)
      if (args.search) params.set('search', args.search)
      const path = `/api/apps/${appId}/logs?${params}`
      // One-shot/initial reads absorb brief edge outages. Follow mode owns its
      // longer retry loop and abort signal below, so keep that request direct.
      return signal
        ? apiFetch<AppLogsResponse>(DEPLOY_URL, token, path, { signal })
        : apiFetchReadWithRetry<AppLogsResponse>(DEPLOY_URL, token, path)
    }

    const print = (events: AppLogEvent[]) => {
      for (const e of events) {
        process.stdout.write(
          args.json ? JSON.stringify(e) + '\n' : formatEvent(e, stdoutColor()) + '\n',
        )
      }
    }

    // Every truncation surface emits the same discriminable NDJSON meta record
    // (events never carry `type`); only the human wording differs per site.
    const noteTruncation = (humanMessage: string) => {
      if (args.json) {
        process.stdout.write(JSON.stringify({ type: 'meta', truncated: true }) + '\n')
      } else {
        console.error(humanMessage)
      }
    }

    // Follow mode tails from the max page too — a first page capped at the
    // default 100 would drop the rest of the initial window and jump the cursor
    // past it. One-shot mode keeps the user's (possibly unset) --limit.
    const first = await fetchPage(initialSince, args.follow ? followLimit : limit, token)
    // Follow mode's OPENING frame, before any event: a tail on a quiet (or
    // never-deployed) app otherwise emits zero bytes forever, and an agent
    // cannot tell "connected, nothing to report" from "wedged" — the same
    // ambiguity the one-shot meta frame removes. `activity --follow` opens
    // with a `ready` line; this matches it.
    if (args.follow && args.json) {
      process.stdout.write(
        JSON.stringify({
          type: 'ready',
          appId,
          window: windowLabel,
          count: first.events.length,
          retentionDays: LOG_RETENTION_DAYS,
        }) + '\n',
      )
    }
    print(first.events)

    if (!args.follow) {
      if (first.events.length === 0) {
        if (args.json) {
          // An empty NDJSON stream is indistinguishable from a crash without a
          // trailing record — emit a discriminable meta line so an agent can
          // tell "ran, no events" from "died". (events never carry `type`.)
          // Carries what the human line carries — a "machine mirror" that
          // knows less than the prose it mirrors is not one.
          process.stdout.write(
            JSON.stringify({
              type: 'meta',
              count: 0,
              window: windowLabel,
              appId,
              retentionDays: LOG_RETENTION_DAYS,
            }) + '\n',
          )
        } else {
          console.log(
            `No logs in the last ${windowLabel} for ${appId}. New logs can take up to a minute to appear; retention is ${LOG_RETENTION_DAYS} days.`,
          )
        }
      } else if (first.truncated) {
        noteTruncation(
          args.search
            ? `(showing the newest ${first.events.length} matches — search scans at most the newest 500 level-filtered events per fetch; narrow with --since/--level or raise --limit)`
            : `(showing the newest ${first.events.length} events — narrow with --since/--level)`,
        )
      }
      return
    }

    // ── Follow mode ──────────────────────────────────────────────────────────
    // Ctrl+C ends the tail by ABORTING the poll loop, never process.exit(0):
    // exiting while undici still holds the connection a poll just used trips
    // libuv's `!(handle->flags & UV_HANDLE_CLOSING)` assertion on Windows and
    // turns a clean stop into a 0xC0000409 abort (see lib/command.ts).
    // Returning lets Node exit naturally with 0. `once`, so a second Ctrl+C
    // falls back to Node's default hard kill if a hung request ignores the
    // abort.
    const tail = new AbortController()
    process.once('SIGINT', () => tail.abort())
    if (!args.json) {
      console.error(`Tailing logs for ${appId} — Ctrl+C to stop.`)
    }

    // Poll for the newest events each tick. A page is capped at `limit`; when
    // more than that arrive between two polls, the server returns the NEWEST
    // and the cursor advances past the oldest of the burst — those are dropped,
    // not just delayed (CF's telemetry API has no ascending order to drain
    // forward). Default follow polls to the max page size to shrink that window,
    // and warn on `truncated` so a drop is never silent.
    const seen = new SeenEvents()
    seen.fresh(first.events)
    let cursor = first.cursor ?? initialSince
    let interval = Math.max(first.pollIntervalMs || 0, MIN_POLL_MS)
    let backoff = 0
    // Warn only on the transition into truncation, not every poll — a
    // sustained burst would otherwise flood the stream.
    let warnedTruncated = false

    // The initial page can already be truncated (the window held more than one
    // page). The loop only checks pages it fetches, so surface it once here —
    // otherwise `-f` would drop the overflow silently, unlike one-shot mode.
    if (first.truncated) {
      warnedTruncated = true
      noteTruncation(
        paint(
          '33',
          args.search
            ? `(search scanned only the newest ${MAX_LIMIT} level-filtered events in the initial ${windowLabel} window — older matches may be omitted; narrow with --since/--level)`
            : `(more than ${followLimit} events in the initial ${windowLabel} window — some older events not shown; narrow with --since/--level)`,
          stderrColor(),
        ),
      )
    }

    for (;;) {
      try {
        await sleep(backoff || interval, tail.signal)
      } catch {
        return // aborted: Ctrl+C — exit 0 through the natural path
      }
      // Refresh the token BEFORE the retryable fetch: the JWT is 15-minute-lived
      // and a tail outlives it. A refresh failure (session expired / logged out)
      // throws a plain Error and is fatal — it will not fix itself by retrying,
      // so let it propagate and end the tail cleanly.
      const freshToken = await ensureToken()
      if (tail.signal.aborted) return
      let page: AppLogsResponse
      try {
        // Re-scan a lag window before the cursor so a late-ingested,
        // earlier-stamped event isn't skipped; SeenEvents drops the overlap.
        page = await fetchPage(
          nextPollSince(cursor, initialSince),
          followLimit,
          freshToken,
          tail.signal,
        )
      } catch (err) {
        // Ctrl+C aborted the in-flight poll — not a fetch failure to report.
        if (tail.signal.aborted) return
        if (err instanceof ApiError && fatalFollowStatus(err.status)) throw err
        backoff = Math.min(backoff ? backoff * 2 : MIN_POLL_MS, 30_000)
        const msg = err instanceof Error ? err.message : String(err)
        console.error(
          paint('2', `(logs fetch failed: ${msg} — retrying in ${backoff / 1000}s)`, stderrColor()),
        )
        continue
      }
      backoff = 0
      interval = Math.max(page.pollIntervalMs || 0, MIN_POLL_MS)
      const fresh = seen.fresh(page.events)
      print(fresh)
      // Normally only a full page of genuinely-new events proves a drop;
      // `page.truncated` can merely count re-scanned lag-window overlap. With
      // search, however, the server scans a fixed newest-500 raw page before
      // filtering, so a truncated scan can omit older matches even when very
      // few matching DTOs survive.
      const realDrop = fresh.length >= followLimit || Boolean(args.search && page.truncated)
      if (realDrop && !warnedTruncated) {
        warnedTruncated = true
        noteTruncation(
          paint(
            '33',
            args.search
              ? `(search scanned only the newest ${MAX_LIMIT} level-filtered events this poll — older matches may be omitted; narrow with --level)`
              : `(burst exceeded ${followLimit} events/poll — some may be dropped; narrow with --level)`,
            stderrColor(),
          ),
        )
      } else if (!realDrop) {
        warnedTruncated = false
      }
      if (page.cursor !== null) cursor = page.cursor
    }
  },
})
