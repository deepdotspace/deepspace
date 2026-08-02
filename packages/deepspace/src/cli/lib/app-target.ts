/** Resolve explicit or local app selectors to canonical app ids. */

import { APP_ID_RE, readAppId } from './app-identity'
import { apiFetch } from './api'
import { InputError } from './cli-errors'
import { findAppDir } from './app-context'
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

interface AppListEntry {
  appId: string
  name: string | null
}

/** Find an app id or subdomain name in the caller's registry list. */
export function matchAppSelector(apps: AppListEntry[], selector: string): string | null {
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
  const { apps } = await apiFetch<{ apps: AppListEntry[] }>(deployUrl, token, '/api/apps')
  if (!Array.isArray(apps)) {
    throw new InputError(
      `The deploy service at ${deployUrl} returned an unexpected response shape for the app list — ` +
        `check DEEPSPACE_DEPLOY_URL (is this the service the app lives on?).`,
      'invalid_response',
    )
  }
  const id = matchAppSelector(apps, selector)
  if (id) return id

  // The owner-scoped app list omits apps on which the caller collaborates.
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
): Promise<string> {
  const { app, error } = parseAppArg(explicit)
  if (error) throw new InputError(error, 'invalid_app')
  if (app !== undefined) return resolveAppSelector(deployUrl, token, app)
  const appDir = findAppDir()
  const id = appDir ? readAppId(appDir) : null
  if (!id) {
    throw new InputError(
      'No app id. Run from an app directory whose wrangler.toml carries DEEPSPACE_APP_ID, or pass --app <id or name>.',
      'not_in_app_repo',
    )
  }
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

/** Validate that a target is locally determinable before reading credentials. */
export function assertAppTargetResolvable(appArg: string | undefined): void {
  const { app, error } = parseAppArg(appArg)
  if (error) throw new InputError(error, 'invalid_app')
  if (app !== undefined) return

  const appDir = findAppDir()
  if (!appDir || !readAppId(appDir)) {
    throw new InputError(
      'No app id. Run from an app directory whose wrangler.toml carries DEEPSPACE_APP_ID, or pass --app <id or name>.',
      'not_in_app_repo',
    )
  }
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
    const { apps } = await apiFetch<{ apps: AppListEntry[] }>(deployUrl, token, '/api/apps')
    if (!apps.some((app) => app.appId === appId)) {
      process.stderr.write(
        `warning: ${appId} is not among your apps. If it exists and you have access ` +
          `(collaborator/admin), the server will use it; if it doesn't exist, this will ` +
          `register it as a NEW app under your account — check the id if that's not what ` +
          `you meant (a subdomain name also works with -a).\n`,
      )
    }
  } catch {
    // Advisory only.
  }
}
