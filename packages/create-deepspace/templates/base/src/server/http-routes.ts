/**
 * HTTP routes that proxy app requests to DeepSpace platform services.
 *
 * The app worker remains the security boundary: caller identity is derived
 * from a verified JWT, caller-supplied identity headers are removed, and app
 * identity is re-asserted only from worker bindings.
 */

import type { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
  apiWorkerFetch,
  authWorkerFetch,
  BROWSER_PROXY_ROUTES,
  isPlatformReservedPath,
  platformWorkerFetch,
  resolveAppRole,
  verifyJwt,
} from 'deepspace/worker'
import type { JwtVerifierConfig, VerifyResult } from 'deepspace/worker'
import { integrations } from '../integrations.js'
import type { AppContext, Env } from '../../worker.js'

function jwtConfig(env: Env): JwtVerifierConfig {
  return { publicKey: env.AUTH_JWT_PUBLIC_KEY, issuer: env.AUTH_JWT_ISSUER }
}

export async function resolveAuth(req: Request, env: Env): Promise<VerifyResult | null> {
  const header = req.headers.get('Authorization')
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return null
  return (await verifyJwt(jwtConfig(env), token)).result
}

/**
 * Re-assert this app's identity headers on a proxied request, fail-closed.
 * Never forwards caller-supplied identity; attaches ours only when the app
 * has a token (absent pre-first-deploy — see Env.APP_IDENTITY_TOKEN).
 */
function reassertAppIdentity(headers: Headers, env: Env): void {
  headers.delete('x-app-identity-token')
  headers.delete('x-app-id')
  if (!env.APP_IDENTITY_TOKEN) return
  headers.set('x-app-identity-token', env.APP_IDENTITY_TOKEN)
  headers.set('x-app-id', env.DEEPSPACE_APP_ID)
}

/** Register auth, debug, and integration routes in their required order. */
export function registerAuthAndIntegrationRoutes(app: Hono<AppContext>): void {
  // Social OAuth redirect + code exchange.
  app.get('/api/auth/social-redirect', (c) => {
    const provider = c.req.query('provider')
    if (!provider) return c.json({ error: 'Missing provider' }, 400)

    const appOrigin = new URL(c.req.url).origin
    const authOrigin = new URL(c.env.AUTH_WORKER_URL).origin

    return c.redirect(
      `${authOrigin}/login/social?provider=${encodeURIComponent(provider)}&returnTo=${encodeURIComponent(appOrigin)}`,
    )
  })

  app.get('/api/auth/oauth-complete', async (c) => {
    const code = c.req.query('code')
    const appOrigin = new URL(c.req.url).origin
    // Land the signed-in user in the app, not on the static landing. `/` is a
    // static page (no auth/realtime providers), so redirecting there after auth
    // would strand the user; `/home` is the dynamic app boundary.
    const appHome = `${appOrigin}/home`

    if (!code) return c.redirect(appHome)

    const res = await authWorkerFetch(c.env, '/api/auth/exchange-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })

    if (!res.ok) return c.redirect(appHome)
    const data = (await res.json()) as { sessionToken?: string }
    if (!data.sessionToken) return c.redirect(appHome)
    const sessionToken = data.sessionToken

    return new Response(null, {
      status: 302,
      headers: {
        Location: appHome,
        'Set-Cookie': `__Secure-better-auth.session_token=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
      },
    })
  })

  app.all('/api/auth/sign-out', async (c) => {
    try {
      await authWorkerFetch(c.env, '/api/auth/sign-out', {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
      })
    } catch {
      // Still expire the app-scoped cookie below. A network/auth-worker
      // failure must not leave the browser immediately signed back in.
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie':
          '__Secure-better-auth.session_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      },
    })
  })

  // Auth proxy → auth-worker (same-origin cookies).
  app.all('/api/auth/*', async (c) => {
    const url = new URL(c.req.url)
    const res = await authWorkerFetch(c.env, url.pathname + url.search, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
    })
    const headers = new Headers(res.headers)
    const setCookie = headers.get('set-cookie')
    if (setCookie) {
      headers.set('set-cookie', setCookie.replace(/;\s*Domain=[^;]*/gi, ''))
    }
    return new Response(res.body, { status: res.status, headers })
  })

  // Debug proxy → app's RecordRoom DO.
  //
  // Both this proxy and the DO gate on ALLOW_DEBUG_ROUTES === "true". The app
  // proxy also requires the existing owner/admin role before reaching the DO.
  app.all('/api/debug/*', async (c) => {
    if (c.env.ALLOW_DEBUG_ROUTES !== 'true') {
      return c.notFound()
    }
    const auth = await resolveAuth(c.req.raw, c.env)
    if (!auth) return c.json({ error: 'unauthorized' }, 401)
    if ((await resolveAppRole(c.env, auth.userId)) !== 'admin') {
      return c.json({ error: 'forbidden' }, 403)
    }
    const stub = c.env.RECORD_ROOMS.get(
      c.env.RECORD_ROOMS.idFromName(`app:${c.env.DEEPSPACE_APP_ID}`),
    )
    // Forward verbatim: the DO dispatches on the original pathname.
    return stub.fetch(c.req.raw)
  })

  // Integrations proxy → api-worker.
  app.get('/api/integrations', async (c) => {
    try {
      const res = await apiWorkerFetch(c.env, '/api/integrations')
      return new Response(res.body, { status: res.status, headers: res.headers })
    } catch {
      return c.json({ error: 'Failed to fetch integration catalog' }, 502)
    }
  })

  // OAuth connection state is always user-billed, so forward the caller JWT.
  app.get('/api/integrations/status', async (c) => {
    const auth = await resolveAuth(c.req.raw, c.env)
    if (!auth) return c.json({ error: 'Sign in required' }, 401)
    const token = c.req.header('Authorization')?.slice(7)
    try {
      const res = await apiWorkerFetch(c.env, '/api/integrations/status', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      return new Response(res.body, { status: res.status, headers: res.headers })
    } catch {
      return c.json({ error: 'Status proxy failed' }, 502)
    }
  })

  app.delete('/api/integrations/oauth/:provider/disconnect', async (c) => {
    const auth = await resolveAuth(c.req.raw, c.env)
    if (!auth) return c.json({ error: 'Sign in required' }, 401)
    const token = c.req.header('Authorization')?.slice(7)
    const provider = c.req.param('provider')
    try {
      const res = await apiWorkerFetch(
        c.env,
        `/api/integrations/oauth/${encodeURIComponent(provider)}/disconnect`,
        {
          method: 'DELETE',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
      )
      return new Response(res.body, { status: res.status, headers: res.headers })
    } catch {
      return c.json({ error: 'Disconnect proxy failed' }, 502)
    }
  })

  app.all('/api/integrations/:name/:endpoint', async (c) => {
    const integrationName = c.req.param('name')
    const billingMode = integrations[integrationName]?.billing ?? 'developer'

    const auth = await resolveAuth(c.req.raw, c.env)
    if (!auth && billingMode === 'user') {
      return c.json({ error: 'Sign in required for this integration' }, 401)
    }

    const target = `/api/integrations/${integrationName}/${c.req.param('endpoint')}`
    const headers: Record<string, string> = {
      'Content-Type': c.req.header('Content-Type') ?? 'application/json',
    }

    // The api-worker bills the JWT subject: developer mode uses the app owner;
    // user mode forwards the caller. There is no client billing override.
    if (billingMode === 'developer') {
      headers['Authorization'] = `Bearer ${c.env.APP_OWNER_JWT}`
    } else {
      const token = c.req.header('Authorization')?.slice(7)
      if (token) headers['Authorization'] = `Bearer ${token}`
    }

    // Identify this app for per-app integrations. Pre-first-deploy there is no
    // token, so omit both headers and let the api-worker fail closed.
    if (c.env.APP_IDENTITY_TOKEN) {
      headers['x-app-identity-token'] = c.env.APP_IDENTITY_TOKEN
      headers['x-app-id'] = c.env.DEEPSPACE_APP_ID
    }

    const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD'
    const body = hasBody ? await c.req.text() : undefined

    try {
      const res = await apiWorkerFetch(c.env, target, {
        method: c.req.method,
        headers,
        body,
      })
      return new Response(res.body, { status: res.status, headers: res.headers })
    } catch {
      return c.json({ error: 'Integration proxy failed' }, 502)
    }
  })
}

/** Register scoped-file and authenticated browser-to-platform proxies. */
export function registerPlatformProxyRoutes(app: Hono<AppContext>): void {
  // Scoped R2 files → platform-worker. The app has no local R2 binding; the
  // platform bucket scopes keys to the verified app and, by default, user.
  app.all('/api/files/*', async (c) => {
    const auth = await resolveAuth(c.req.raw, c.env)
    const userId = auth?.userId ?? null

    const url = new URL(c.req.url)
    const platformUrl = new URL(c.req.url)
    platformUrl.pathname = url.pathname.replace('/api/files', '/internal/files')

    const headers = new Headers(c.req.raw.headers)
    // platform-worker trusts x-user-id after app HMAC validation. Always remove
    // caller input and derive it from the verified JWT.
    headers.delete('x-user-id')
    reassertAppIdentity(headers, c.env)
    if (userId) headers.set('x-user-id', userId)

    const resp = await platformWorkerFetch(
      c.env,
      new Request(platformUrl.toString(), {
        method: c.req.method,
        headers,
        body: c.req.raw.body,
      }),
    )

    // Rewrite platform URLs in JSON responses to use the app's origin.
    const contentType = resp.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const body = (await resp.json()) as Record<string, unknown>
      const rewriteUrl = (value: string) => value.replace(/^https?:\/\/[^/]+/, url.origin)
      if (typeof body.url === 'string') body.url = rewriteUrl(body.url)
      if (Array.isArray(body.files)) {
        for (const file of body.files as Array<Record<string, unknown>>) {
          if (typeof file.url === 'string') file.url = rewriteUrl(file.url)
        }
      }
      return c.json(body, resp.status as ContentfulStatusCode)
    }

    return new Response(resp.body, { status: resp.status, headers: resp.headers })
  })

  // Same-origin browser proxy for authenticated SDK hooks. Keep this an exact
  // (method, path) allowlist: prefix matching would expose deploy/CLI routes.
  app.all('/_deepspace/*', async (c) => {
    const url = new URL(c.req.url)
    const method = c.req.method
    const route = BROWSER_PROXY_ROUTES.find(
      (candidate) => candidate.method === method && candidate.path === url.pathname,
    )
    if (!route) {
      return c.json({ error: 'not_found' }, 404)
    }

    const auth = await resolveAuth(c.req.raw, c.env)
    if (!auth?.userId) return c.json({ error: 'unauthorized' }, 401)

    // Always overwrite caller input with this worker's immutable app id.
    const forwardedParams = new URLSearchParams(url.search)
    forwardedParams.set('appId', c.env.DEEPSPACE_APP_ID)
    const queryString = forwardedParams.toString()
    const apiPath =
      url.pathname.replace('/_deepspace/', '/api/') + (queryString ? `?${queryString}` : '')

    const headers = new Headers(c.req.raw.headers)
    headers.delete('x-user-id')
    reassertAppIdentity(headers, c.env)
    headers.set('x-user-id', auth.userId)

    return apiWorkerFetch(c.env, apiPath, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : c.req.raw.body,
    })
  })
}

const matches = (pathname: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))

/**
 * An unmatched API call must 404 without consulting the asset layer at all —
 * answering it with a static file, or with HTML a client then parses as JSON,
 * is never right.
 */
const API_PREFIXES = ['/api']

/**
 * A FILE, not a client route: last segment carries an extension. Wrong in only
 * the cheap direction — a dotted route 404s visibly, where a missing file
 * getting the shell is HTML parsed as JavaScript and a blank page.
 */
function namesAFile(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1)
  return last.includes('.')
}

/**
 * Register the client-route fallback last so it cannot shadow worker routes.
 * Deploys set `not_found_handling: "none"`, so a 404 from the binding is a
 * real miss and this worker makes the call the asset layer cannot.
 */
export function registerStaticRoutes(app: Hono<AppContext>): void {
  app.get('*', async (c) => {
    const url = new URL(c.req.url)
    if (matches(url.pathname, API_PREFIXES)) {
      return c.json({ error: 'not_found' }, 404)
    }
    const response = await c.env.ASSETS.fetch(c.req.raw)
    if (response.status !== 404) return response

    if (namesAFile(url.pathname) || isPlatformReservedPath(url.pathname)) {
      return c.json({ error: 'not_found' }, 404)
    }
    // `/`, not `/index.html`: auto-trailing-slash redirects the explicit
    // filename, and the browser would follow it off the URL it asked for.
    url.pathname = '/'
    return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw))
  })
}
