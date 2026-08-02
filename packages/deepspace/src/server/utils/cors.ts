/**
 * Wildcard-aware CORS origin matching for the platform workers.
 *
 * Hono's array form of `cors({ origin: [...] })` is an exact `includes()` — it
 * never expands `*`. Every worker that listed `https://*.app.space` or
 * `http://localhost:*` in an array had a dead entry: the wildcard rows matched
 * nothing, silently narrowing the effective CORS surface to the literal
 * entries. This helper is the single implementation both the api and deploy
 * workers pass to Hono's function-form `origin`, so the pattern semantics
 * can't drift between them.
 *
 * `*` stands for exactly one host label or a port: it never crosses a dot or
 * a slash, so `https://*.app.space` matches `https://x.app.space` but neither
 * `https://a.b.app.space` nor `https://x.app.space.evil.com`.
 */
export function matchOrigin(origin: string, patterns: string[]): string | null {
  if (!origin) return null
  const matches = patterns.some((pattern) => {
    const rx = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^./]+')
    return new RegExp(`^${rx}$`).test(origin)
  })
  return matches ? origin : null
}

/**
 * The platform's standard browser-origin allow-list, derived from the
 * environment's apexes so a second constellation (staging) trusts its own
 * hosts and only its own. Both values are explicit deployment-plane config.
 * Dedupes for environments that serve both roles from one apex.
 */
export function platformCorsPatterns(env: { APP_DOMAIN: string; PLATFORM_DOMAIN: string }): string[] {
  const app = env.APP_DOMAIN
  const platform = env.PLATFORM_DOMAIN
  return [
    ...new Set([`https://${platform}`, `https://*.${platform}`, `https://*.${app}`]),
    'http://localhost:*',
  ]
}
