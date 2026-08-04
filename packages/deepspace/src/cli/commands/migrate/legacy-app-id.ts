import { APP_ID_RE, readWranglerIdentityConfig } from '../../lib/app-identity'
import { InputError } from '../../lib/cli-errors'

const LEGACY_APP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Resolve a pre-app-id checkout without guessing between historical identity fields. */
export function readLegacyAppId(cwd: string = process.cwd(), wranglerEnv?: string): string | null {
  const cfg = readWranglerIdentityConfig(cwd)
  if (!cfg) return null
  const slot = wranglerEnv ? cfg.env?.[wranglerEnv] : cfg
  if (!slot) return null
  const declaredId = slot.vars?.DEEPSPACE_APP_ID
  if (declaredId !== undefined) {
    if (typeof declaredId === 'string' && LEGACY_APP_ID_RE.test(declaredId)) return declaredId
    throw new InputError(
      'DEEPSPACE_APP_ID is present but invalid; correct it before migrating.',
      'invalid_app_id',
    )
  }
  const appName = typeof slot.vars?.APP_NAME === 'string' ? slot.vars.APP_NAME : null
  const workerName = typeof slot.name === 'string' ? slot.name : null
  if (!appName) return null
  if (!workerName) {
    throw new InputError(
      'Legacy migration requires both Worker name and APP_NAME to be present and identical.',
      'ambiguous_legacy_app_id',
    )
  }
  if (appName !== workerName) {
    throw new InputError(
      `Legacy APP_NAME "${appName}" does not match Worker name "${workerName}"; migration cannot choose safely.`,
      'ambiguous_legacy_app_id',
    )
  }
  return !APP_ID_RE.test(appName) && LEGACY_APP_ID_RE.test(appName) ? appName : null
}

export function legacyDeployRefusal(
  appDir: string,
  wranglerEnv?: string,
): { error: string; code: string } | null {
  const legacyAppId = readLegacyAppId(appDir, wranglerEnv)
  return legacyAppId
    ? {
        error: `This checkout still uses legacy app identity ${legacyAppId}. Run \`deepspace app migrate --dry-run\`, then complete \`deepspace app migrate\` before deploying.`,
        code: 'legacy_app_migration_required',
      }
    : null
}
