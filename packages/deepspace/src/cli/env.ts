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

export const PLATFORM_URLS =
  DEEPSPACE_ENV === 'production'
    ? PROD_URLS
    : DEEPSPACE_ENV === 'staging'
      ? STAGING_URLS
      : INVALID_URLS

/** Every plane's auth service — the key credentials are stored under (see
 *  cli/auth.ts), so a refusal can name the plane a stored session belongs to. */
export const PLANE_AUTH_URLS: Record<Exclude<DeepSpaceEnvironment, 'invalid'>, string> = {
  production: PROD_URLS.auth,
  staging: STAGING_URLS.auth,
}

/** Report per-service process overrides without changing the stable presets. */
export function effectivePlatformUrls(env: NodeJS.ProcessEnv = process.env) {
  return {
    auth: env.DEEPSPACE_AUTH_URL ?? PLATFORM_URLS.auth,
    api: env.DEEPSPACE_API_URL ?? PLATFORM_URLS.api,
    platform: env.DEEPSPACE_PLATFORM_URL ?? PLATFORM_URLS.platform,
    deploy: env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy,
  }
}

export const DASHBOARD_URL =
  DEEPSPACE_ENV === 'production'
    ? 'https://dashboard.deep.space'
    : DEEPSPACE_ENV === 'staging'
      ? 'https://dashboard.deepspacesites.com'
      : 'http://127.0.0.1:9'
