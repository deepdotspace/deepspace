/**
 * Native OAuth bridge for Expo clients.
 *
 * Better Auth's browser flow ends in an HttpOnly cookie, which a native app
 * cannot read. These app-worker handlers keep that cookie server-side while
 * returning a short-lived JWT and the long-lived session token to the Expo
 * client over TLS. Native flows use PKCE: the one-time callback code is not
 * redeemable without the verifier held by the initiating app.
 */
import { verifyJwt } from './auth'
import { authWorkerFetch, type AuthWorkerEnv } from './utils/proxies'
import { SESSION_COOKIE } from '../shared/auth-session'

export interface ExpoAuthWorkerEnv extends AuthWorkerEnv {
  AUTH_WORKER_URL?: string
  AUTH_JWT_PUBLIC_KEY?: string
  AUTH_JWT_ISSUER?: string
}

export interface ExpoAuthBridgeOptions {
  /** Exact native callback URIs registered by the app. */
  allowedRedirectUris?: readonly string[]
}

const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/

function allowedRedirect(value: string, options: ExpoAuthBridgeOptions = {}): boolean {
  try {
    // Parse first so malformed values cannot be accepted through a string-list
    // configuration by accident. The exact comparison prevents redirecting a
    // one-time code to an arbitrary path on an otherwise trusted origin.
    new URL(value)
    return options.allowedRedirectUris?.includes(value) ?? false
  } catch {
    return false
  }
}

function validState(value: string | null): boolean {
  return value === null || (value.length >= 1 && value.length <= 1024)
}

function validPkce(challenge: string | null, method: string | null, required = false): boolean {
  if (!challenge && !method) return !required
  return method === 'S256' && !!challenge && CODE_CHALLENGE_RE.test(challenge)
}

function authWorkerUnavailable(): Response {
  return Response.json({ error: 'The authentication service is not configured.' }, { status: 503 })
}

export function nativeAuthStart(
  request: Request,
  env: ExpoAuthWorkerEnv,
  options?: ExpoAuthBridgeOptions,
): Response {
  const url = new URL(request.url)
  const provider = url.searchParams.get('provider')
  const redirectUri = url.searchParams.get('redirect_uri')
  const state = url.searchParams.get('state')
  const codeChallenge = url.searchParams.get('code_challenge')
  const codeChallengeMethod = url.searchParams.get('code_challenge_method')
  if (
    !provider ||
    !redirectUri ||
    !validState(state) ||
    !allowedRedirect(redirectUri, options) ||
    !validPkce(codeChallenge, codeChallengeMethod, true)
  ) {
    return Response.json({ error: 'A supported provider, PKCE challenge, and registered redirect URI are required.' }, { status: 400 })
  }
  if (!env.AUTH_WORKER_URL) return authWorkerUnavailable()

  // The auth-worker completes the browser flow by replacing the path with
  // /api/auth/oauth-complete; the app exposes that route and forwards it to
  // nativeAuthCallback. The request origin is the deployed app origin, so no
  // separately provisioned APP_ORIGIN binding can drift from the live host.
  const callback = new URL('/api/auth/oauth-complete', url.origin)
  callback.searchParams.set('redirect_uri', redirectUri)
  if (state) callback.searchParams.set('state', state)
  if (codeChallenge) {
    callback.searchParams.set('code_challenge', codeChallenge)
    callback.searchParams.set('code_challenge_method', 'S256')
  }
  const authUrl = new URL('/login/social', env.AUTH_WORKER_URL)
  authUrl.searchParams.set('provider', provider)
  authUrl.searchParams.set('returnTo', callback.toString())
  return Response.redirect(authUrl.toString(), 302)
}

export function nativeAuthCallback(
  request: Request,
  _env: ExpoAuthWorkerEnv,
  options?: ExpoAuthBridgeOptions,
): Response {
  const url = new URL(request.url)
  const redirectUri = url.searchParams.get('redirect_uri')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const codeChallenge = url.searchParams.get('code_challenge')
  const codeChallengeMethod = url.searchParams.get('code_challenge_method')
  if (
    !redirectUri ||
    !code ||
    code.length > 4096 ||
    !validState(state) ||
    !validPkce(codeChallenge, codeChallengeMethod, true) ||
    !allowedRedirect(redirectUri, options)
  ) {
    return Response.json({ error: 'The sign-in callback was incomplete.' }, { status: 400 })
  }
  const destination = new URL(redirectUri)
  destination.searchParams.set('code', code)
  if (state) destination.searchParams.set('state', state)
  return Response.redirect(destination.toString(), 302)
}

export async function nativeAuthExchange(request: Request, env: ExpoAuthWorkerEnv): Promise<Response> {
  const body = await request.json().catch(() => null) as { code?: unknown; code_verifier?: unknown } | null
  if (
    !body ||
    typeof body.code !== 'string' ||
    body.code.length < 8 ||
    body.code.length > 4096 ||
    typeof body.code_verifier !== 'string' ||
    !CODE_VERIFIER_RE.test(body.code_verifier)
  ) {
    return Response.json({ error: 'A valid one-time sign-in code and PKCE verifier are required.' }, { status: 400 })
  }

  let exchange: Response
  try {
    exchange = await authWorkerFetch(env, '/api/auth/exchange-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: body.code, code_verifier: body.code_verifier }),
    })
  } catch {
    return Response.json({ error: 'The authentication service is unavailable.' }, { status: 502 })
  }
  if (!exchange.ok) {
    const definitiveFailure = exchange.status === 400 || exchange.status === 401
    return Response.json(
      { error: definitiveFailure ? 'The sign-in code expired. Please try again.' : 'The authentication service is unavailable.' },
      { status: definitiveFailure ? 401 : 502 },
    )
  }

  const exchanged = await exchange.json().catch(() => null) as { sessionToken?: unknown } | null
  if (!exchanged || typeof exchanged.sessionToken !== 'string') {
    return Response.json({ error: 'The auth service did not issue a session.' }, { status: 502 })
  }

  let tokenResponse: Response | null = null
  let token: { token?: unknown } | null = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      tokenResponse = await authWorkerFetch(env, '/api/auth/token', {
        method: 'POST',
        headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(exchanged.sessionToken)}` },
      })
    } catch {
      tokenResponse = null
    }
    if (tokenResponse?.ok) {
      token = await tokenResponse.json().catch(() => null) as { token?: unknown } | null
      if (token && typeof token.token === 'string') break
    }
    if (tokenResponse?.status === 401) break
  }
  if (!tokenResponse) {
    return Response.json({ error: 'The authentication service is unavailable.' }, { status: 502 })
  }
  if (!tokenResponse.ok) {
    return Response.json(
      tokenResponse.status === 401
        ? { error: 'The sign-in session expired. Please try again.' }
        : { error: 'The authentication service is unavailable.' },
      { status: tokenResponse.status === 401 ? 401 : 502 },
    )
  }
  if (!token || typeof token.token !== 'string') {
    return Response.json({ error: 'The auth service did not issue an access token.' }, { status: 502 })
  }
  return Response.json(
    { sessionToken: exchanged.sessionToken, accessToken: token.token },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function nativeAuthToken(request: Request, env: ExpoAuthWorkerEnv): Promise<Response> {
  const input = await request.json().catch(() => null) as { sessionToken?: unknown } | null
  if (!input || typeof input.sessionToken !== 'string' || input.sessionToken.length < 16 || input.sessionToken.length > 4096) {
    return Response.json({ error: 'A valid DeepSpace session is required.' }, { status: 401 })
  }
  let response: Response
  try {
    response = await authWorkerFetch(env, '/api/auth/token', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(input.sessionToken)}` },
    })
  } catch {
    return Response.json({ error: 'The authentication service is unavailable.' }, { status: 502 })
  }
  if (!response.ok) {
    return Response.json(
      { error: response.status === 401 ? 'The DeepSpace session expired.' : 'The authentication service is unavailable.' },
      { status: response.status === 401 ? 401 : 502 },
    )
  }
  const body = await response.json().catch(() => null) as { token?: unknown } | null
  if (!body || typeof body.token !== 'string') {
    return Response.json({ error: 'The auth service did not issue an access token.' }, { status: 502 })
  }
  return Response.json(
    { accessToken: body.token },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function nativeAuthMe(request: Request, env: ExpoAuthWorkerEnv): Promise<Response> {
  if (!env.AUTH_JWT_PUBLIC_KEY || !env.AUTH_JWT_ISSUER) {
    return Response.json({ error: 'JWT verification is not configured.' }, { status: 500 })
  }
  const header = request.headers.get('Authorization')
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null
  const verified = await verifyJwt(
    { publicKey: env.AUTH_JWT_PUBLIC_KEY, issuer: env.AUTH_JWT_ISSUER },
    token,
  )
  if (!verified.result) return Response.json({ error: 'Sign in required.' }, { status: 401 })
  return Response.json(
    { userId: verified.result.userId, claims: verified.result.claims },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function nativeAuthSignOut(request: Request, env: ExpoAuthWorkerEnv): Promise<Response> {
  const body = await request.json().catch(() => null) as { sessionToken?: unknown } | null
  if (body && typeof body.sessionToken === 'string' && body.sessionToken.length >= 16 && body.sessionToken.length <= 4096) {
    try {
      await authWorkerFetch(env, '/api/auth/sign-out', {
        method: 'POST',
        headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(body.sessionToken)}` },
      })
    } catch {
      // Sign-out is best effort; the local secure-store entry is still cleared.
    }
  }
  return Response.json({ ok: true })
}
