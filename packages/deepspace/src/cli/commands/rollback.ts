/**
 * `deepspace rollback [release-id]` — restore a prior release, instantly.
 *
 * Re-ships the exact bundle that release deployed (retained server-side at
 * deploy time) — no rebuild, no local checkout needed. Secrets stay as they
 * are; only code moves. The rollback itself becomes the newest release, so
 * history is append-only and a rollback can be rolled back.
 *
 * With no argument, targets the release before the current one.
 *
 * Defined with the command runtime (lib/command.ts): `--json`, the envelope,
 * the slug, and the exit codes come from there, not from this file.
 */

import * as p from '@clack/prompts'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { resolveAppTarget, assertAppTargetResolvable, parseWranglerEnvArg } from '../lib/app-target'
import { apiFetch, ApiError } from '../lib/api'
import { mintIdempotencyKey, repoApi } from '../lib/repo-api'
import { createSpinner } from '../lib/spinner'
import { waitForLiveRelease, type ReleaseWait } from '../lib/edge-propagation'
import { defineDeepspaceCommand, Refusal } from '../lib/command'

const REL_ID_RE = /^rel_[0-9A-HJKMNP-TV-Z]{26}$/

export function unavailableDoGuardRefusal(message: string): Refusal {
  return new Refusal(
    `${message}\nRetry in a moment, or re-run with --allow-do-deletion to accept the risk.`,
    'do_guard_unavailable',
  )
}

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

/**
 * Pick the default rollback target (the release before the current one) from
 * the two most-recent releases. Pure + exported for tests: the two rejection
 * states carry stable machine `code`s parallel to the explicit-id `not_found`,
 * so release automation distinguishes empty history from a single-release repo
 * without scraping the prose.
 */
export function pickPreviousRelease(
  releases: { id: string }[],
): { releaseId: string } | { error: string; code: string } {
  if (releases.length === 0) {
    return { error: 'No releases recorded yet — nothing to roll back to.', code: 'no_releases' }
  }
  if (releases.length === 1) {
    return {
      error:
        'Only one release exists — nothing earlier to roll back to. Pass an explicit release id once more history accrues.',
      code: 'no_previous_release',
    }
  }
  return { releaseId: releases[1].id }
}

export default defineDeepspaceCommand({
  meta: {
    name: 'rollback',
    description: "Re-deploy a prior release's exact bundle (no rebuild)",
  },
  args: {
    release: {
      type: 'positional',
      description: 'Release id (rel_…) from `deepspace releases` (default: the previous release)',
      required: false,
    },
    app: {
      type: 'string',
      alias: 'a',
      description: 'App id or subdomain name (default: the surrounding app directory)',
      required: false,
    },
    env: {
      type: 'string',
      alias: 'e',
      description: "wrangler.toml [env.<name>] slot — selects that environment's app id",
      required: false,
    },
    'allow-do-deletion': {
      type: 'boolean',
      description:
        'Proceed even though the target release declares fewer Durable Object classes than ' +
        'the current one — THEIR STORED DATA IS DELETED.',
      default: false,
    },
  },
  async run({ args }) {
    const appArg = args.app as string | undefined
    const envArg = args.env as string | undefined
    // An explicitly-blank release id must not silently auto-pick the previous
    // release (a mutating op) — an unset `rollback "$VAR"` would roll back to an
    // unintended target. Absent (no positional) still auto-picks by design.
    if (args.release !== undefined) {
      const r = String(args.release).trim()
      if (!r) {
        throw new Refusal(
          '--release was given an empty release id — pass a rel_… id, or omit it to roll back to the previous release.',
          'invalid_release',
        )
      }
      if (!REL_ID_RE.test(r)) {
        throw new Refusal(`Invalid release id: ${r} (expected rel_<ULID>).`, 'invalid_release')
      }
    }
    // Blank --app / missing app context is a client-side error — reject it
    // BEFORE the token read so it never surfaces as not_authenticated.
    assertAppTargetResolvable(appArg, { wranglerEnv: envArg })
    const { wranglerEnv } = parseWranglerEnvArg(envArg)
    const spinner = args.json ? null : createSpinner()
    spinner?.start('Preparing rollback…')
    const token = await ensureToken()
    const appId = await resolveAppTarget(DEPLOY_URL, token, appArg, { wranglerEnv: envArg })
    const api = repoApi(DEPLOY_URL, token, appId)

    let releaseId = args.release ? String(args.release).trim() : ''
    if (!releaseId) {
      const { releases } = await api.listReleases(2)
      const picked = pickPreviousRelease(releases)
      if ('error' in picked) throw new Refusal(picked.error, picked.code)
      releaseId = picked.releaseId
    }

    spinner?.message(`Rolling back to ${releaseId}…`)
    let result: {
      success: boolean
      url?: string
      versionId?: string
      rolledBackTo?: string
      releaseId?: string
      bundleRetained?: boolean
      releaseStamp?: string
      // 'unverified' when --allow-do-deletion bypassed the DO-class guard, so
      // the platform did NOT check the rollback against the live DO classes.
      doClassGuard?: string
    }
    try {
      result = await apiFetch(DEPLOY_URL, token, `/api/deploy/${appId}/rollback`, {
        method: 'POST',
        body: JSON.stringify({
          releaseId,
          idempotencyKey: mintIdempotencyKey(),
          ...(args['allow-do-deletion'] ? { allowDoClassDeletion: true } : {}),
        }),
      })
    } catch (err) {
      // Data-loss consent is a user decision, never an executable action.
      if (err instanceof ApiError && err.code === 'do_class_deletion') {
        throw new Refusal(
          `${err.message}\nRe-run with --allow-do-deletion to accept the data loss.`,
          err.code,
        )
      }
      // Fail-closed guard: the platform couldn't verify which Durable Object
      // classes are live, so it refused rather than risk deleting one's data.
      if (err instanceof ApiError && err.code === 'do_guard_unavailable') {
        throw unavailableDoGuardRefusal(err.message)
      }
      throw err
    }
    if (!result.success) {
      // A 2xx that isn't a well-formed rollback ack — e.g. a wrong/broken service
      // answering 200 {} — must NOT read as a successful (mutating) rollback. Code
      // it like the repo-API shape guard so a --json caller can classify it.
      throw new Refusal(
        'The deploy service returned an unexpected response to the rollback — check DEEPSPACE_DEPLOY_URL (is this the service the app lives on?).',
        'invalid_response',
      )
    }
    // Same guard deploy holds: the platform ack means accepted, not serving.
    // Without this, rollback reports success while the edge still answers with
    // the release it was asked to replace.
    let serving: ReleaseWait = 'unverifiable'
    if (result.url) {
      spinner?.message('Waiting for the edge to serve this release...')
      serving = await waitForLiveRelease(result.url, result.releaseStamp, 90_000)
    }
    spinner?.stop(
      serving === 'confirmed'
        ? `Rolled back to ${result.rolledBackTo ?? releaseId}.`
        : serving === 'unconfirmed'
          ? `Rolled back to ${result.rolledBackTo ?? releaseId} — the edge is still rolling it out.`
          : `Rolled back to ${result.rolledBackTo ?? releaseId} — serving could not be verified from here.`,
    )
    // Degraded guard: --allow-do-deletion bypassed the DO-class check, so the
    // platform never verified this rollback against the live Durable Object
    // classes. Surface it in both modes — an agent branches on the field.
    const doClassGuard = result.doClassGuard === 'unverified' ? ('unverified' as const) : undefined
    if (!args.json) {
      if (result.url) {
        if (serving === 'unconfirmed') p.log.warn(`URL: ${result.url} (accepted; serving not yet verified)`)
        else p.log.success(`Live at: ${result.url}`)
      }
      if (result.bundleRetained === false) {
        p.log.warn(
          'The rollback is live, but its bundle was concurrently retired and is not available for a future rollback.',
        )
      }
      if (doClassGuard === 'unverified') {
        p.log.warn(
          'DO-class guard bypassed (--allow-do-deletion): this rollback was NOT checked against the ' +
            "live Durable Object classes — any class the target doesn't declare has been deleted with its data.",
        )
      }
      p.log.info(
        'This rollback is itself the newest release — `deepspace releases` shows the full history.',
      )
    }
    return {
      data: {
        appId,
        rolledBackTo: result.rolledBackTo ?? releaseId,
        newReleaseId: result.releaseId ?? null,
        bundleRetained: result.bundleRetained ?? null,
        url: result.url ?? null,
        versionId: result.versionId ?? null,
        wranglerEnv: wranglerEnv ?? null,
        // Always present, matching `deploy`: one field to branch on.
        serving,
        ...(doClassGuard ? { doClassGuard } : {}),
      },
    }
  },
})
