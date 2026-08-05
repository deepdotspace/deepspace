export interface DocumentationPublicLimiterEnv {
  DEEPSPACE_APP_ID: string
  DOCUMENTATION_CLIENT_RATE_LIMITER?: RateLimit
  DOCUMENTATION_APP_RATE_LIMITER?: RateLimit
}

export type DocumentationPublicLimitResult = { ok: true } | { ok: false; status: 429 | 503 }

/** Hash the edge client address before it becomes a rate-limit key. */
export async function documentationPublicClientKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Apply client and app budgets through Cloudflare's edge-local rate-limit API. */
export async function checkDocumentationPublicLimit(
  env: DocumentationPublicLimiterEnv,
  clientKey: string,
  logPrefix: string,
): Promise<DocumentationPublicLimitResult> {
  const clientLimiter = env.DOCUMENTATION_CLIENT_RATE_LIMITER
  const appLimiter = env.DOCUMENTATION_APP_RATE_LIMITER
  if (!clientLimiter || !appLimiter) return { ok: false, status: 503 }
  try {
    const client = await clientLimiter.limit({ key: `${env.DEEPSPACE_APP_ID}:${clientKey}` })
    if (!client.success) return { ok: false, status: 429 }
    const app = await appLimiter.limit({ key: env.DEEPSPACE_APP_ID })
    return app.success ? { ok: true } : { ok: false, status: 429 }
  } catch (error) {
    console.error(`[${logPrefix}] limiter unavailable: ${documentationLimiterErrorSummary(error)}`)
    return { ok: false, status: 503 }
  }
}

/** Keep binding diagnostics visible in Workers string logs. */
export function documentationLimiterErrorSummary(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  const value = error as Record<string, unknown>
  return JSON.stringify({
    name: typeof value.name === 'string' ? value.name : undefined,
    message: typeof value.message === 'string' ? value.message : undefined,
    retryable: value.retryable === true,
    overloaded: value.overloaded === true,
    cause: typeof value.cause === 'string' ? value.cause : undefined,
  })
}
