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

import { defineCommand } from 'citty'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { apiFetch, ApiError } from '../lib/api'
import { InputError } from '../lib/cli-errors'
import { findAppDir } from '../lib/app-context'
import { resolveAppTarget } from '../lib/app-target'
import { readAppId } from '../lib/app-identity'
// Whitelisted wire DTO + level set — shared with the platform reader and the
// dashboard (packages/deepspace/src/shared/log-events.ts) so they can't drift.
import { LOG_LEVELS, type AppLogEvent, type AppLogsResponse } from '../../shared/log-events'

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

/**
 * The page size a follow tail requests. Follow defaults to the max page so a
 * burst between polls is less likely to overflow one page and silently drop its
 * oldest events; an explicit `--limit` still wins. Exported for tests.
 */
export function followInitialLimit(limit: number | undefined, maxLimit: number): number {
  return limit ?? maxLimit
}

/**
 * Where the next follow poll starts: `FOLLOW_LAG_MS` before the last cursor,
 * floored at the original window start so a tail never scans before the user's
 * `--since`. Exported for tests.
 */
export function nextPollSince(cursor: number, floor: number, lagMs: number = FOLLOW_LAG_MS): number {
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
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as 's' | 'm' | 'h' | 'd']
    ts = now - Number(rel[1]) * unit
  } else {
    ts = Date.parse(trimmed)
    if (Number.isNaN(ts)) {
      throw new InputError(`Invalid --since "${input}" — use 30s, 15m, 2h, 7d, or an ISO timestamp.`, 'invalid_since')
    }
  }
  if (now - ts > RETENTION_MS) {
    throw new InputError('Logs are retained for 7 days — --since can reach back at most 7d.', 'since_out_of_range')
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

  let tag: string
  let body: string
  if (e.eventType === 'exception' && e.exception) {
    tag = paint('31', 'ERROR', color)
    const where = e.request ? ` — ${e.request.method} ${e.request.path}` : ''
    body = `${e.exception.name}: ${e.exception.message}${where}`
    if (e.exception.stack) {
      // Drop a leading "Name: message" header line (V8 style) so it isn't
      // shown twice — but Cloudflare worker stacks are often frame-only
      // (e.g. "    at fetch (index.js:1:1)") with NO header, so only strip the
      // first line when it actually IS that header. Otherwise we'd eat a frame.
      const lines = e.exception.stack.split('\n')
      const firstIsHeader = lines.length > 0 && !/^\s*at\s/.test(lines[0]) && lines[0].includes(e.exception.message)
      const frames = (firstIsHeader ? lines.slice(1) : lines)
        .map((l) => '    ' + l.trim())
        .filter((l) => l.trim().length > 0)
      if (frames.length) body += '\n' + paint('2', frames.join('\n'), color)
    }
  } else if (e.eventType === 'request' && e.request) {
    tag = paint('36', 'REQ  ', color)
    const status = e.request.status !== undefined ? ` ${e.request.status}` : ''
    const outcome = e.outcome && e.outcome !== 'ok' ? ` (${e.outcome})` : ''
    body = `${e.request.method} ${e.request.path}${status}${outcome}`
  } else {
    const style = LEVEL_STYLE[e.level]
    tag = (e.level.toUpperCase() + '     ').slice(0, 5)
    if (style) tag = paint(style, tag, color)
    body = style ? paint(style, e.message, color) : e.message
  }

  // A browser-forwarded error is tagged so it's not mistaken for a server log.
  const client = e.source === 'client' ? paint('35', 'CLIENT', color) + ' ' : ''
  return `${time} ${client}${tag} ${body}`
}

// ── Command ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
      description: 'Only events whose message contains this text',
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
    const token = await ensureToken()

    const wranglerEnv = args.env?.trim() || undefined
    // --app and --env are two different ways to name the target. Combining them
    // is ambiguous — and previously --env was silently ignored when --app was
    // also passed — so fail fast rather than tail the wrong app.
    if (args.app && wranglerEnv) {
      throw new InputError(
        'Pass either --app or --env, not both — --env reads the [env.<name>] block’s own app id, --app names an app directly.',
        'ambiguous_target',
      )
    }
    let appId: string
    if (!args.app && wranglerEnv) {
      // `--env <name>` targets the [env.<name>] block's own app id (a staging
      // deploy is its own app) — same convention as `secrets --env`.
      const appDir = findAppDir()
      const id = appDir ? readAppId(appDir, wranglerEnv) : null
      if (!id) {
        throw new InputError(
          `No app id for env "${wranglerEnv}" — wrangler.toml has no [env.${wranglerEnv}] block with its own DEEPSPACE_APP_ID.`,
          'no_app_id_for_env',
        )
      }
      appId = id
    } else {
      appId = await resolveAppTarget(DEPLOY_URL, token, args.app)
    }

    if (args.level && !(LOG_LEVELS as readonly string[]).includes(args.level)) {
      throw new InputError(`Invalid --level "${args.level}". Use: ${LOG_LEVELS.join(', ')}`, 'invalid_level')
    }
    let limit: number | undefined
    if (args.limit !== undefined) {
      limit = Number(args.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new InputError('Invalid --limit — expected an integer between 1 and 500.', 'invalid_limit')
      }
    }

    const initialSince = args.since ? parseSince(args.since) : Date.now() - DEFAULT_WINDOW_MS
    const windowLabel = args.since?.trim() || '15m'

    // Server clamp; used as the follow-mode default so a burst between polls is
    // less likely to overflow one page (see the truncation note below).
    const MAX_LIMIT = 500
    const followLimit = followInitialLimit(limit, MAX_LIMIT)

    const fetchPage = async (
      since: number,
      pageLimit: number | undefined,
      token: string,
    ): Promise<AppLogsResponse> => {
      const params = new URLSearchParams({ since: String(since) })
      if (pageLimit !== undefined) params.set('limit', String(pageLimit))
      if (args.level) params.set('level', args.level)
      if (args.search) params.set('search', args.search)
      return apiFetch<AppLogsResponse>(DEPLOY_URL, token, `/api/apps/${appId}/logs?${params}`)
    }

    const print = (events: AppLogEvent[]) => {
      for (const e of events) {
        process.stdout.write(args.json ? JSON.stringify(e) + '\n' : formatEvent(e, stdoutColor()) + '\n')
      }
    }

    // Follow mode tails from the max page too — a first page capped at the
    // default 100 would drop the rest of the initial window and jump the cursor
    // past it. One-shot mode keeps the user's (possibly unset) --limit.
    const first = await fetchPage(initialSince, args.follow ? followLimit : limit, token)
    print(first.events)

    if (!args.follow) {
      if (first.events.length === 0) {
        if (args.json) {
          // An empty NDJSON stream is indistinguishable from a crash without a
          // trailing record — emit a discriminable meta line so an agent can
          // tell "ran, no events" from "died". (events never carry `type`.)
          process.stdout.write(JSON.stringify({ type: 'meta', count: 0, window: windowLabel }) + '\n')
        } else {
          console.log(
            `No logs in the last ${windowLabel} for ${appId}. New logs can take up to a minute to appear; retention is 7 days.`,
          )
        }
      } else if (first.truncated) {
        // A machine consumer reading NDJSON needs the signal too — emit a
        // discriminable meta record (events never carry a `type` field).
        if (args.json) process.stdout.write(JSON.stringify({ type: 'meta', truncated: true }) + '\n')
        else console.error(`(showing the newest ${first.events.length} events — narrow with --since/--level/--search)`)
      }
      return
    }

    // ── Follow mode ──────────────────────────────────────────────────────────
    process.on('SIGINT', () => process.exit(0))
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
      if (args.json) {
        process.stdout.write(JSON.stringify({ type: 'meta', truncated: true }) + '\n')
      } else {
        console.error(
          paint('33', `(more than ${followLimit} events in the initial ${windowLabel} window — some older events not shown; narrow with --since/--level/--search)`, stderrColor()),
        )
      }
    }

    for (;;) {
      await sleep(backoff || interval)
      // Refresh the token BEFORE the retryable fetch: the JWT is 5-minute-lived
      // and a tail outlives it. A refresh failure (session expired / logged out)
      // throws a plain Error and is fatal — it will not fix itself by retrying,
      // so let it propagate and end the tail cleanly.
      const freshToken = await ensureToken()
      let page: AppLogsResponse
      try {
        // Re-scan a lag window before the cursor so a late-ingested,
        // earlier-stamped event isn't skipped; SeenEvents drops the overlap.
        page = await fetchPage(nextPollSince(cursor, initialSince), followLimit, freshToken)
      } catch (err) {
        // Auth/authz/absence is fatal — the situation won't improve by
        // retrying. Everything else (5xx, 429, network) backs off.
        if (err instanceof ApiError && [401, 403, 404].includes(err.status)) throw err
        backoff = Math.min(backoff ? backoff * 2 : MIN_POLL_MS, 30_000)
        const msg = err instanceof Error ? err.message : String(err)
        console.error(paint('2', `(logs fetch failed: ${msg} — retrying in ${backoff / 1000}s)`, stderrColor()))
        continue
      }
      backoff = 0
      interval = Math.max(page.pollIntervalMs || 0, MIN_POLL_MS)
      const fresh = seen.fresh(page.events)
      print(fresh)
      // Warn only when a poll delivered a FULL page of genuinely-new events —
      // the real drop signal. `page.truncated` counts the re-scanned (already
      // seen, deduped) lag-window overlap toward the cap, so it cries wolf on a
      // busy-but-lossless tail; `fresh.length` excludes that overlap.
      const realDrop = fresh.length >= followLimit
      if (realDrop && !warnedTruncated) {
        warnedTruncated = true
        if (args.json) {
          process.stdout.write(JSON.stringify({ type: 'meta', truncated: true }) + '\n')
        } else {
          console.error(
            paint('33', `(burst exceeded ${followLimit} events/poll — some may be dropped; narrow with --level/--search)`, stderrColor()),
          )
        }
      } else if (!realDrop) {
        warnedTruncated = false
      }
      if (page.cursor !== null) cursor = page.cursor
    }
  },
})
