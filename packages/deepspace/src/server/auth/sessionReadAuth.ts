/**
 * Session-cookie identity for header-less file reads.
 *
 * `<img>`, `<audio>`, `<video>`, and `<a href>` cannot send `Authorization`,
 * but the browser attaches the app-origin Better Auth session cookie to every
 * same-origin load. This exchanges that cookie for the same 15-minute JWT the
 * client already holds and returns only the verified identity.
 *
 * Bearer always wins: this applies only when no `Authorization` header is
 * present, only to GET/HEAD, and only when `Sec-Fetch-Site` is `same-origin`
 * or `none`. `app.space` is not on the Public Suffix List, so a sibling
 * `evil.app.space` is same-SITE and `SameSite=Lax` alone would let its
 * `<img src>` carry the victim's cookie; `Sec-Fetch-Site` cannot be set by
 * page script. A browser that omits it (Safari before 16.4) and a cross-site
 * top-level link both get 401 by design.
 */

import { SESSION_COOKIE } from '../../shared/auth-session'
import { authWorkerFetch, type AuthWorkerEnv } from '../utils/proxies'
import { verifyJwt } from './jwtVerifier'
import type { VerifyResult } from './types'

type SessionReadEnv = AuthWorkerEnv & { AUTH_JWT_PUBLIC_KEY: string; AUTH_JWT_ISSUER: string }

const TTL_MS = 5 * 60_000

/**
 * One identity per (isolate, session) for five minutes — a third of the JWT's
 * own lifetime, which the browser already caches. In-flight and resolved
 * results share an entry, so a page of concurrent `<img>` loads costs one
 * exchange; a failed exchange is dropped rather than remembered.
 */
const sessions = new Map<string, { promise: Promise<VerifyResult | null>; expiresAt: number }>()

async function exchange(session: string, env: SessionReadEnv): Promise<VerifyResult | null> {
  try {
    const res = await authWorkerFetch(env, '/api/auth/token', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE}=${session}` },
      signal: AbortSignal.timeout(10_000),
    })
    const { token } = res.ok ? ((await res.json()) as { token?: unknown }) : {}
    if (typeof token !== 'string') return null
    const config = { publicKey: env.AUTH_JWT_PUBLIC_KEY, issuer: env.AUTH_JWT_ISSUER }
    return (await verifyJwt(config, token)).result
  } catch {
    return null
  }
}

/**
 * Identify a same-origin GET/HEAD by the app-origin session cookie. Returns
 * `null` — never throws — whenever the request does not qualify or the
 * exchange fails. Use it only as the fallback after bearer verification.
 */
export async function resolveSessionReadAuth(
  req: Request,
  env: SessionReadEnv,
): Promise<VerifyResult | null> {
  const site = req.headers.get('Sec-Fetch-Site')
  if (req.method !== 'GET' && req.method !== 'HEAD') return null
  if (req.headers.has('Authorization') || (site !== 'same-origin' && site !== 'none')) return null
  const session = (req.headers.get('Cookie') ?? '')
    .split(';')
    .find((part) => part.trim().startsWith(`${SESSION_COOKIE}=`))
    ?.trim()
    .slice(SESSION_COOKIE.length + 1)
  if (!session) return null

  const now = Date.now()
  const cached = sessions.get(session)
  if (cached && cached.expiresAt > now) return cached.promise
  if (sessions.size >= 500) sessions.clear()
  // Inserted before the exchange settles so every concurrent miss joins it.
  const promise = exchange(session, env).then((result) => {
    if (!result) sessions.delete(session)
    return result
  })
  sessions.set(session, { promise, expiresAt: now + TTL_MS })
  return promise
}
