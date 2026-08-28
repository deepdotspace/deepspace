import { validateAppName } from './rooms/app-name'

/**
 * First-party non-app origins allowed as agent targets on the production app
 * domain. The token minter and the CLI must agree on this policy, so both the
 * set AND the "is production" predicate (appDomain === PRODUCTION_APP_DOMAIN)
 * live here — callers never re-derive either.
 */
export const PRODUCTION_OFFICIAL_AGENT_ORIGINS: readonly string[] = ['https://admin.deep.space']
const PRODUCTION_APP_DOMAIN = 'app.space'

export interface AgentTargetPolicy {
  appDomain: string
  allowLoopback?: boolean
}

/** Normalize an agent target only when it is an exact trusted origin. */
export function normalizeAgentTargetOrigin(
  value: unknown,
  policy: AgentTargetPolicy,
): string | null {
  if (typeof value !== 'string' || !value) return null

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null

  const hostname = url.hostname.toLowerCase()
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
  if (loopback) {
    return policy.allowLoopback && ['http:', 'https:'].includes(url.protocol) ? url.origin : null
  }
  if (url.protocol !== 'https:' || url.port) return null

  if (
    policy.appDomain.toLowerCase() === PRODUCTION_APP_DOMAIN &&
    PRODUCTION_OFFICIAL_AGENT_ORIGINS.includes(url.origin)
  ) {
    return url.origin
  }

  const suffix = `.${policy.appDomain.toLowerCase()}`
  if (!hostname.endsWith(suffix)) return null
  const label = hostname.slice(0, -suffix.length)
  return !label.includes('.') && validateAppName(label).valid ? url.origin : null
}
