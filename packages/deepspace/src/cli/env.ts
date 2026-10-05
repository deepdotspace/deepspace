/** Stable platform-environment selection shared by every CLI command. */

/**
 * `staging` targets the isolated constellation on spacestest.com. Unknown
 * explicit values are invalid and receive inert URLs, never production URLs.
 */
export type DeepSpaceEnvironment = 'production' | 'staging' | 'invalid'

export function resolveDeepSpaceEnvironment(value: string | undefined): DeepSpaceEnvironment {
  if (value === undefined || value === 'production') return 'production'
  if (value === 'staging') return 'staging'
  return 'invalid'
}

export const DEEPSPACE_ENV = resolveDeepSpaceEnvironment(process.env.DEEPSPACE_ENV)

const PROD_URLS = {
  auth: 'https://auth.deep.space',
  api: 'https://api-worker.deep.space',
  platform: 'https://platform-worker.deep.space',
  deploy: 'https://deploy-worker.deep.space',
} as const

const STAGING_URLS = {
  // Services live on deepspacesites.com, apps on spacestest.com. This mirrors
  // prod's two-zone split because a Worker cannot fetch one in its own zone.
  auth: 'https://auth.deepspacesites.com',
  api: 'https://api.deepspacesites.com',
  platform: 'https://platform.deepspacesites.com',
  deploy: 'https://deploy.deepspacesites.com',
} as const

// Defense in depth for callers imported without cli.ts's validation.
const INVALID_URLS = {
  auth: 'http://127.0.0.1:9',
  api: 'http://127.0.0.1:9',
  platform: 'http://127.0.0.1:9',
  deploy: 'http://127.0.0.1:9',
} as const

/** Canonical app-hosting domain for a plane (deployed apps live on `<name>.<domain>`). */
export function appDomainForEnv(env: DeepSpaceEnvironment): string | null {
  return env === 'production' ? 'app.space' : env === 'staging' ? 'spacestest.com' : null
}

/** Canonical platform-service domain for a plane. */
export function platformDomainForEnv(env: DeepSpaceEnvironment): string | null {
  return env === 'production' ? 'deep.space' : env === 'staging' ? 'deepspacesites.com' : null
}

export const PLATFORM_URLS =
  DEEPSPACE_ENV === 'production'
    ? PROD_URLS
    : DEEPSPACE_ENV === 'staging'
      ? STAGING_URLS
      : INVALID_URLS

/** The canonical URL set of each real plane, independent of the process's own
 *  DEEPSPACE_ENV selection — for callers that must pin or verify a plane. */
export const PLANE_URLS = {
  production: PROD_URLS,
  staging: STAGING_URLS,
} as const

/** Every plane's auth service — the key credentials are stored under (see
 *  cli/auth.ts), so a refusal can name the plane a stored session belongs to. */
export const PLANE_AUTH_URLS: Record<Exclude<DeepSpaceEnvironment, 'invalid'>, string> = {
  production: PLANE_URLS.production.auth,
  staging: PLANE_URLS.staging.auth,
}

/** Resolve per-service process overrides against the stable presets. The
 *  lazy readers (lib/vc-remote, lib/dev-vars, commands/status) call this per
 *  invocation — tests pin that; the constants below snapshot it at import. */
export function effectivePlatformUrls(env: NodeJS.ProcessEnv = process.env) {
  return {
    auth: env.DEEPSPACE_AUTH_URL ?? PLATFORM_URLS.auth,
    api: env.DEEPSPACE_API_URL ?? PLATFORM_URLS.api,
    platform: env.DEEPSPACE_PLATFORM_URL ?? PLATFORM_URLS.platform,
    deploy: env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy,
  }
}

/** The resolved service URLs (per-service env override, else the plane
 *  preset), snapshotted at import like `DEEPSPACE_ENV` itself — the one copy
 *  of the `process.env.X ?? PLATFORM_URLS.y` fallback every command used to
 *  hand-roll at module level. (The three lazy call sites above are the
 *  deliberate exceptions — converting them breaks their env-mutation tests.) */
export const {
  auth: AUTH_URL,
  api: API_URL,
  platform: PLATFORM_URL,
  deploy: DEPLOY_URL,
} = effectivePlatformUrls()

export const DASHBOARD_URL =
  DEEPSPACE_ENV === 'production'
    ? 'https://dashboard.deep.space'
    : DEEPSPACE_ENV === 'staging'
      ? 'https://dashboard.deepspacesites.com'
      : 'http://127.0.0.1:9'
