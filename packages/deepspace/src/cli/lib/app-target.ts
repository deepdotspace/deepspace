/** Resolve explicit or local app selectors to canonical app ids. */

import { APP_ID_RE, readAppId } from './app-identity'
import { apiFetchReadWithRetry } from './api'
import { InputError, Refusal } from './cli-errors'
import { findAppDir } from './app-context'
import { noWranglerConfigMessage } from './wrangler-env'
import { resolveAppIdByName } from './repo-api'
import { STRICT_APP_ID_RE } from '../../server/utils/registry-client'
import { APP_NAME_RULES } from '../../server/rooms/app-name'

function isCanonicalAppName(name: string): boolean {
  return (
    name.length >= APP_NAME_RULES.minLength &&
    name.length <= APP_NAME_RULES.maxLength &&
    APP_NAME_RULES.pattern.test(name)
  )
}

/** Resolve an explicit app id, or read it from the surrounding app. */
export function requireAppIdArg(explicit: string | undefined): string {
  const { app, error } = parseAppArg(explicit)
  if (error) throw new InputError(error, 'invalid_app')
  if (app !== undefined) {
    if (!APP_ID_RE.test(app)) {
      throw new Error(`"${app}" is not an app id (app_…). Pass --app <appId>.`)
    }
    return app
  }
  const appDir = findAppDir()
  const id = appDir ? readAppId(appDir) : null
  if (!id) {
    throw new Error(
      'No app id. Run from an app directory whose wrangler.toml carries DEEPSPACE_APP_ID, or pass --app <appId>.',
    )
  }
  return id
}

/** One row of `GET /api/apps` — the registry's own view of an app. */
export interface AppListEntry {
  appId: string
  status: string
  createdAt: string
  deployedAt: string | null
  /** Current subdomain lease; null when no route is active. */
  name: string | null
  url: string | null
  /** Absent when an older deploy worker answers a newer CLI. */
  role?: 'owner' | 'collaborator'
  /** A name this app released and still holds — nothing routes to it. */
  reservedName?: string | null
  /** When that hold lapses and the name returns to the open pool. */
  reservedUntil?: string | null
}

/** A transfer offer addressed to the caller, from `GET /api/apps`. */
export interface PendingTransferOffer {
  appId: string
  fromUserId: string
  createdAt: string
  expiresAt: string
}

/**
 * The one answer to "is this app serving right now", for every command that
 * asks. Undeploy releases the routes and flips the status but leaves the
 * release log untouched, so the release row alone cannot tell live from
 * taken-down — only the registry can, and this is where it is read.
 */
export function liveAppUrl(app: AppListEntry): string | null {
  return app.status === 'active' && app.deployedAt !== null ? app.url : null
}

/**
 * The whole `GET /api/apps` page: the caller's apps — owned and collaborated
 * — plus the transfer offers addressed to them, which belong to no app they
 * can access yet and so appear in no other listing.
 */
export async function listAppsPage(
  deployUrl: string,
  token: string,
): Promise<{ apps: AppListEntry[]; pendingTransfers: PendingTransferOffer[] }> {
  const body = await apiFetchReadWithRetry<{
    apps: AppListEntry[]
    pendingTransfers?: PendingTransferOffer[]
  }>(deployUrl, token, '/api/apps')
  if (!Array.isArray(body.apps)) {
    throw new InputError(
      `The deploy service at ${deployUrl} returned an unexpected response shape for the app list — ` +
        `check DEEPSPACE_DEPLOY_URL (is this the service the app lives on?).`,
      'invalid_response',
    )
  }
  // Absent when an older deploy worker answers a newer CLI.
  return { apps: body.apps, pendingTransfers: body.pendingTransfers ?? [] }
}

/** Fetch the caller's apps — owned and collaborated — from the registry. */
export async function listApps(deployUrl: string, token: string): Promise<AppListEntry[]> {
  return (await listAppsPage(deployUrl, token)).apps
}

export interface AppTargetOptions {
  /** Raw `--env` value. Preserve blank-vs-absent so blank never falls back to production. */
  wranglerEnv?: string
}

/** Find an app id or subdomain name in the caller's registry list. */
export function matchAppSelector(
  apps: Array<Pick<AppListEntry, 'appId' | 'name'>>,
  selector: string,
): string | null {
  const byId = apps.find((app) => app.appId === selector)
  if (byId) return byId.appId
  const byName = apps.find((app) => app.name === selector)
  if (byName) return byName.appId
  return STRICT_APP_ID_RE.test(selector) ? selector : null
}

/** Resolve an app id or live subdomain name to the canonical app id. */
export async function resolveAppSelector(
  deployUrl: string,
  token: string,
  selector: string,
): Promise<string> {
  if (STRICT_APP_ID_RE.test(selector)) return selector
  const id = matchAppSelector(await listApps(deployUrl, token), selector)
  if (id) return id

  // A name resolves through the repo even when the registry list can't see it
  // (an admin acting on someone else's app).
  const shared = await resolveAppIdByName(deployUrl, token, selector)
  if (shared) return shared
  throw new InputError(
    `No app "${selector}" found, or you don't have access to it. ` +
      `If the app exists but was never deployed, it has no name yet; target it by app id. ` +
      `Run \`deepspace app list\` to list your apps and their ids.`,
    'app_not_found',
  )
}

/** Resolve an explicit selector, or read the surrounding app id. */
export async function resolveAppTarget(
  deployUrl: string,
  token: string,
  explicit: string | undefined,
  options: AppTargetOptions = {},
): Promise<string> {
  assertAppTargetResolvable(explicit, options)
  const { app, error } = parseAppArg(explicit)
  if (error) throw new InputError(error, 'invalid_app')
  if (app !== undefined) return resolveAppSelector(deployUrl, token, app)
  const { wranglerEnv } = parseWranglerEnvArg(options.wranglerEnv)
  const appDir = findAppDir()
  const id = appDir ? readAppId(appDir, wranglerEnv) : null
  // `assertAppTargetResolvable` already produced the precise failure. Keeping
  // this guard makes the filesystem race explicit without weakening the type.
  if (!id) throw appTargetMissingError(appDir, wranglerEnv)
  return id
}

/** Preserve absent-vs-blank so a blank selector cannot target the local app. */
export function parseAppArg(raw: string | undefined): { app?: string; error?: string } {
  if (raw === undefined) return {}
  const selector = raw.trim()
  if (selector === '') {
    return {
      error:
        '--app was given an empty app id — pass an app id/name, or omit --app to use the current directory.',
    }
  }
  if (selector.startsWith('app_')) {
    if (!STRICT_APP_ID_RE.test(selector)) {
      return {
        error: `--app "${selector}" looks like an app id but isn't a valid app_<ULID> — check for a typo.`,
      }
    }
    return { app: selector }
  }
  if (!isCanonicalAppName(selector)) {
    return {
      error: `--app "${selector}" is not a valid app id or name (expected app_<ULID>, or a subdomain name — lowercase letters, digits and hyphens).`,
    }
  }
  return { app: selector }
}

/** Preserve absent-vs-blank for a named Wrangler environment. */
export function parseWranglerEnvArg(raw: string | undefined): {
  wranglerEnv?: string
  error?: string
} {
  if (raw === undefined) return {}
  const wranglerEnv = raw.trim()
  if (!wranglerEnv) {
    return {
      error:
        '--env was given an empty environment name — pass a wrangler.toml environment name, or omit --env to use the top-level app.',
    }
  }
  return { wranglerEnv }
}

/**
 * The one "which app?" failure for every command that reads the local app.
 * Three states, three codes — an agent branching on `code` must be able to
 * tell them apart, and each has a different remedy:
 *   - not in an app directory at all → `not_in_app_repo` (cd or scaffold, or --app)
 *   - in an app whose wrangler.toml has no id yet → `app_not_initialized`, with
 *     the one command that heals it as the action (same tier as deploy's)
 *   - an --env slot with no id of its own → `no_app_id_for_env`
 * A malformed id never reaches here: `readAppId` refuses it (`invalid_app_id`).
 */
export function appTargetMissingError(
  appDir: string | null,
  wranglerEnv: string | undefined,
): InputError | Refusal {
  if (!appDir) {
    return new InputError(
      `${noWranglerConfigMessage(process.cwd())} Or pass --app <id or name> to target an app from anywhere.`,
      'not_in_app_repo',
    )
  }
  if (wranglerEnv) {
    return new InputError(
      `No app id for env "${wranglerEnv}" — wrangler.toml has no [env.${wranglerEnv}] block with its own DEEPSPACE_APP_ID. ` +
        `Each environment is its own app: run \`deepspace app init --env ${wranglerEnv}\` to register one, or omit --env for the top-level app.`,
      'no_app_id_for_env',
    )
  }
  return new Refusal(
    `No app id in ${appDir}/wrangler.toml. Run \`deepspace app init\` to register this app, then retry (or pass --app <id or name>).`,
    'app_not_initialized',
    { action: { cwd: appDir, argv: ['deepspace', 'app', 'init'] }, actionRequired: true },
  )
}

/** Validate that a target is locally determinable before reading credentials. */
export function assertAppTargetResolvable(
  appArg: string | undefined,
  options: AppTargetOptions = {},
): void {
  const { app, error } = parseAppArg(appArg)
  if (error) throw new InputError(error, 'invalid_app')
  const { wranglerEnv, error: envError } = parseWranglerEnvArg(options.wranglerEnv)
  if (envError) throw new InputError(envError, 'invalid_env')
  if (app !== undefined && wranglerEnv) {
    throw new InputError(
      "Pass either --app or --env, not both — --env reads the [env.<name>] block's own app id, while --app names an app directly.",
      'ambiguous_target',
    )
  }
  if (app !== undefined) return

  const appDir = findAppDir()
  if (!appDir || !readAppId(appDir, wranglerEnv)) throw appTargetMissingError(appDir, wranglerEnv)
}

/** Warn before an explicit unknown id can be registered by push or deploy. */
export async function warnIfPhantomApp(
  deployUrl: string,
  token: string,
  appId: string,
  explicit: string | undefined,
): Promise<void> {
  if (!explicit || !STRICT_APP_ID_RE.test(explicit.trim())) return
  try {
    const apps = await listApps(deployUrl, token)
    if (!apps.some((app) => app.appId === appId)) {
      process.stderr.write(
        `warning: ${appId} is not among your apps. If it exists and you have access ` +
          `(collaborator/admin), the server will use it; if it doesn't exist, the command ` +
          `will be refused (app_not_registered — ids are registered at \`deepspace app ` +
          `init\`). Check the id (a subdomain name also works with -a).\n`,
      )
    }
  } catch {
    // Advisory only.
  }
}
