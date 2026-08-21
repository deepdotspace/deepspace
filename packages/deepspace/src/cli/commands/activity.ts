/**
 * `deepspace activity` — the app's coordination feed: pushes, workspace
 * lifecycle and releases, merged and cursored. This is how an
 * agent answers "did trunk move / did a workspace land / did someone
 * deploy?" without cloning anything.
 *
 *   deepspace activity [--since <cursor|now>] [--limit N] [--json]
 *   deepspace activity --follow          # poll loop (Ctrl-C to stop)
 *
 * Agents own their cursor: keep the returned value and pass it back as
 * `--since`. Follow starts at "now" unless an explicit cursor is supplied,
 * then streams one NDJSON record per fact. There is deliberately no shared
 * machine cursor for sibling agents to consume from each other.
 *
 * Defined with the command runtime (lib/command.ts): `--json`, the envelope,
 * the slug, and the exit codes come from there, not from this file. The one
 * exception is `--follow --json`, a documented NDJSON *stream* that never
 * returns — it emits a ready frame, then one frame per activity or transport
 * error.
 */

import * as p from '@clack/prompts'
import { ensureToken } from '../auth'
import { resolveAppTarget, assertAppTargetResolvable } from '../lib/app-target'
import { deployBaseUrl } from '../lib/vc-remote'
import { releaseSourceLabel, repoApi, type RemoteActivityEvent } from '../lib/repo-api'
import { actorLabels } from '../lib/actor-labels'
import { parseLimitArg, parseCursorArg } from '../lib/citty-args'
import { defineDeepspaceCommand, Refusal } from '../lib/command'
import { errorCode } from '../lib/cli-errors'
import { createSpinner } from '../lib/spinner'

const FOLLOW_INTERVAL_MS = 5_000

/** landedOid → workspace id for a page of events. A land reaches the feed as
 *  a trunk `push` followed by `workspace.landed`, and the undifferentiated
 *  push reads as someone pushing directly to trunk (a live study's only
 *  misreading of shared state). Correlating within the page labels it. */
export function landIndex(events: RemoteActivityEvent[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const e of events) {
    if (e.kind !== 'workspace.landed') continue
    const s = (e.summary ?? {}) as Record<string, unknown>
    if (typeof s.landedOid === 'string' && e.subjectId) m.set(s.landedOid, e.subjectId)
  }
  return m
}

export function formatEvent(
  e: RemoteActivityEvent,
  lands?: Map<string, string>,
  actors?: Map<string, string>,
): string {
  const s = (e.summary ?? {}) as Record<string, unknown>
  const short = (oid: unknown) => (typeof oid === 'string' ? oid.slice(0, 10) : '?')
  const who = (id: unknown) =>
    typeof id === 'string' ? (actors?.get(id) ?? id) : String(id ?? '?')
  let detail = ''
  switch (e.kind) {
    case 'push': {
      const refs = Array.isArray(s.refs) ? (s.refs as Array<{ ref?: string; newOid?: string }>) : []
      detail = refs
        .map((r) => `${String(r.ref ?? '').replace('refs/heads/', '')} → ${short(r.newOid)}`)
        .join(', ')
      const landWs = refs
        .map((r) => (typeof r.newOid === 'string' ? lands?.get(r.newOid) : undefined))
        .find(Boolean)
      if (landWs) detail += ` (land of ${landWs})`
      break
    }
    case 'workspace.created':
      detail = `"${String(s.task ?? '')}" from ${short(s.baseOid)}`
      break
    case 'workspace.synced':
      // The event records only the tip: changed-file counts are client-side
      // diffs by design (do/workspaces.ts), so there is no count to print.
      detail = `→ ${short(s.headOid)}`
      break
    case 'workspace.landed':
      detail = `"${String(s.task ?? '')}" → ${short(s.landedOid)} on ${String(s.into ?? 'trunk')}`
      break
    case 'workspace.dropped':
      detail = `"${String(s.task ?? '')}"`
      break
    case 'release.deploy':
    case 'release.rollback':
      // The feed event carries the same source the release row does, so a
      // GitHub-source release reads as its repository instead of the bare `?`
      // a null commitOid used to print.
      detail = `#${Number(s.seq ?? 0)} ${releaseSourceLabel({
        commitOid: typeof s.commitOid === 'string' ? s.commitOid : null,
        source:
          s.sourceProvider === 'github' && typeof s.sourceRepository === 'string'
            ? { provider: 'github', repository: s.sourceRepository }
            : s.sourceProvider === 'deepspace'
              ? { provider: 'deepspace' }
              : null,
      })}`
      break
    // Unknown kinds still print their kind + actor — never crash the feed.
    default:
      detail = ''
  }
  return `#${e.seq}  ${e.createdAt}  ${e.kind}  ${who(e.actor)}  ${detail}`.trimEnd()
}

export default defineDeepspaceCommand({
  meta: {
    name: 'activity',
    description: "The app's coordination feed (pushes, workspaces, releases)",
  },
  args: {
    since: {
      type: 'string',
      description:
        'Events after this cursor, or "now". One-shot defaults to 0; follow defaults to now',
      required: false,
    },
    limit: { type: 'string', description: 'Max events per page (default 50)', required: false },
    follow: {
      type: 'boolean',
      description: 'Keep polling for new events (Ctrl-C to stop)',
      default: false,
    },
    app: {
      type: 'string',
      alias: 'a',
      description:
        'App id or subdomain name (default: DEEPSPACE_APP_ID from the nearest wrangler.toml)',
      required: false,
    },
  },
  async run({ args }) {
    const appArg = args.app as string | undefined
    // Validate cheap args before any auth/network round-trip. A malformed
    // cursor must FAIL, not silently coerce — an agent with a corrupted saved
    // cursor would otherwise replay full history and mistake it for new
    // activity (parseCursorArg also rejects a fractional cursor rather than
    // flooring it to an earlier page).
    const fromNow = args.since === 'now'
    const { cursor: startCursor, error: cursorError } = fromNow
      ? { cursor: 0, error: null }
      : parseCursorArg(args.since)
    if (cursorError) throw new Refusal(cursorError, 'invalid_cursor')
    const { limit, error: limitError } = parseLimitArg(args.limit)
    if (limitError) throw new Refusal(limitError, 'invalid_limit')
    // Blank --app / missing app context is a client-side error — reject it
    // BEFORE the token read so it never surfaces as not_authenticated.
    assertAppTargetResolvable(appArg)
    const spinner = args.json ? null : createSpinner()
    spinner?.start(args.follow ? 'Starting activity feed…' : 'Loading activity…')
    const token = await ensureToken()
    // Activity is a pure server read — usable from anywhere with -a; the
    // wrangler.toml default applies when run inside an app dir.
    const appId = await resolveAppTarget(deployBaseUrl(), token, appArg)
    const initialApi = repoApi(deployBaseUrl(), token, appId)
    // A follower starts after the latest committed event unless the caller
    // supplied a cursor. The tail read and later activity writes serialize in
    // the same repo DO, so an event cannot slip through the handoff.
    let cursor =
      fromNow || (args.follow && args.since === undefined)
        ? (await initialApi.listActivity({ tail: true })).cursor
        : startCursor

    // Human view only: resolve actor ids to emails once per invocation —
    // raw ids stay in --json (stable surface).
    const actors = args.json ? undefined : await actorLabels(token, appId)
    if (args.follow) {
      spinner?.stop(`Following activity after #${cursor} (Ctrl-C to stop).`)
      if (args.json) {
        console.log(JSON.stringify({ type: 'ready', appId, cursor }))
      }
    }
    for (;;) {
      try {
        // Refresh through the normal session path each iteration. A follow
        // process commonly outlives the short JWT it started with.
        const pageToken = args.follow ? await ensureToken() : token
        const page = await repoApi(deployBaseUrl(), pageToken, appId).listActivity({
          since: cursor,
          limit,
        })
        if (!args.follow) {
          spinner?.stop(
            `Loaded ${page.events.length} ${page.events.length === 1 ? 'event' : 'events'}.`,
          )
        }
        if (args.json) {
          // Follow is an NDJSON stream: one fact per line lets an agent react
          // immediately without unpacking page envelopes.
          if (args.follow) {
            for (const event of page.events) {
              console.log(JSON.stringify({ type: 'activity', appId, cursor: event.seq, event }))
            }
          }
        } else {
          const lands = landIndex(page.events)
          for (const e of page.events) console.log(formatEvent(e, lands, actors))
          if (page.events.length === 0 && !args.follow) {
            p.log.info(cursor > 0 ? `No activity after #${cursor}.` : 'No activity yet.')
          }
        }
        cursor = page.cursor
        const result = { data: { events: page.events, cursor: page.cursor, hasMore: page.hasMore } }
        if (args.json && !args.follow) {
          // Exactly one JSON document per one-shot invocation. The caller
          // pages explicitly while hasMore is true.
          return result
        }
        if (!args.follow) {
          if (page.events.length > 0) {
            p.log.info(
              `Cursor: ${cursor}` +
                (page.hasMore
                  ? ` · more available (next page: --since ${cursor})`
                  : ` (resume later with --since ${cursor})`),
            )
          }
          // A feed reports facts only. Recovery actions belong to the command
          // that actually refuses an operation.
          return result
        }
        if (page.hasMore) continue // a follower drains its backlog before sleeping
      } catch (error) {
        if (!args.follow) throw error
        const code = errorCode(error) ?? 'network_error'
        if (args.json) {
          console.log(
            JSON.stringify({
              type: 'transport',
              appId,
              state: 'retrying',
              cursor,
              retryInMs: FOLLOW_INTERVAL_MS,
              code,
            }),
          )
        } else {
          p.log.warn(`Activity feed interrupted (${code}); retrying in 5s.`)
        }
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, FOLLOW_INTERVAL_MS))
    }
  },
})
