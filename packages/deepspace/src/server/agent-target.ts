import { validateAppName } from './rooms/app-name'

/** First-party non-app origins retained for callers using the legacy policy shape. */
export const PRODUCTION_OFFICIAL_AGENT_ORIGINS: readonly string[] = ['https://admin.deep.space']
const PRODUCTION_APP_DOMAIN = 'app.space'

export interface AgentTargetPolicy {
  appDomain: string
  platformDomain?: string
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

  const appDomain = policy.appDomain.toLowerCase()
  const platformDomain = policy.platformDomain?.toLowerCase()
  const officialAdminOrigin = platformDomain
    ? `https://admin.${platformDomain}`
    : appDomain === PRODUCTION_APP_DOMAIN
      ? PRODUCTION_OFFICIAL_AGENT_ORIGINS[0]
      : null
  if (url.origin === officialAdminOrigin) {
    return url.origin
  }

  const suffix = `.${appDomain}`
  if (!hostname.endsWith(suffix)) return null
  const label = hostname.slice(0, -suffix.length)
  return !label.includes('.') && validateAppName(label).valid ? url.origin : null
}
