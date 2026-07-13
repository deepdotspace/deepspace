/**
 * Upstream worker proxy helpers.
 *
 * App workers reach the platform's other workers (api, platform, auth) through
 * one of two transports:
 *
 *   1. **Service binding** (`env.API_WORKER` / `env.PLATFORM_WORKER`) — the
 *      preferred path in production. Configured via wrangler `[[services]]`.
 *      Cross-worker calls over plain `*.workers.dev` URLs return Cloudflare
 *      error 1042 in production, so the binding is the only working path
 *      in deployed apps.
 *
 *   2. **HTTPS URL** (`env.API_WORKER_URL` / `env.PLATFORM_WORKER_URL`) — the
 *      fallback used in local development. `deepspace dev` writes these
 *      into `.dev.vars`, which `wrangler dev` exposes as env vars. Service
 *      bindings don't work cross-process under `wrangler dev` for SDK apps,
 *      so the URL is the only working path in dev.
 *
 * The auth-worker has no service binding even in production — its responses
 * carry `Set-Cookie` headers we want preserved verbatim, which we get for
 * free over plain HTTPS. So `authWorkerFetch` is URL-only; the helper exists
 * for surface consistency, not to switch transports.
 *
 * Each helper:
 *   - Prefers the binding if present, falls back to the URL otherwise.
 *   - Throws an actionable Error if neither is configured. No silent 502s.
 *   - Forwards `init` (method/headers/body) verbatim to the upstream worker.
 *
 * History: a previous in-tree helper folded the binding/URL fallback into
 * the AI module's `resolveTransport`. Inline call sites in the starter
 * template (integrations, files, debug) used `c.env.X.fetch(...)` directly,
 * which broke `npx deepspace dev` for any app calling those routes — the
 * binding is undefined locally, so the fetch threw. These helpers
 * standardize on the same shape `resolveTransport` had, so every upstream
 * call works in both dev and prod.
 */

/**
 * Env shape required by `apiWorkerFetch`. App workers should extend this
 * (the starter template does) so the helper can be called with `c.env`.
 */
export interface ApiWorkerEnv {
  /** Cloudflare service binding for the api-worker. Preferred. */
  API_WORKER?: Fetcher
  /** HTTPS URL for the api-worker. Used when the binding is absent (dev). */
  API_WORKER_URL?: string
}

/** Env shape required by `platformWorkerFetch`. */
export interface PlatformWorkerEnv {
  /** Cloudflare service binding for the platform-worker. Preferred. */
  PLATFORM_WORKER?: Fetcher
  /** HTTPS URL for the platform-worker. Used when the binding is absent. */
  PLATFORM_WORKER_URL?: string
}

/** Env shape required by `authWorkerFetch`. URL-only. */
export interface AuthWorkerEnv {
  /** HTTPS URL for the auth-worker. Always required. */
  AUTH_WORKER_URL?: string
}

type Transport =
  | { kind: 'binding'; fetcher: Fetcher }
  | { kind: 'url'; baseUrl: string }

/**
 * Resolve the api-worker transport. Exported for the AI helper, which
 * needs the URL form to rewrite an internal `https://api-worker.internal`
 * placeholder before calling the provider SDK.
 */
export function resolveApiTransport(env: ApiWorkerEnv): Transport {
  if (env.API_WORKER) return { kind: 'binding', fetcher: env.API_WORKER }
  if (env.API_WORKER_URL) {
    return { kind: 'url', baseUrl: env.API_WORKER_URL.replace(/\/$/, '') }
  }
  throw new Error(
    'apiWorkerFetch: neither env.API_WORKER nor env.API_WORKER_URL is set. ' +
      'Add a [[services]] binding in wrangler.toml for production, or let ' +
      '`deepspace dev` write API_WORKER_URL into .dev.vars for local development.',
  )
}

function resolvePlatformTransport(env: PlatformWorkerEnv): Transport {
  if (env.PLATFORM_WORKER) return { kind: 'binding', fetcher: env.PLATFORM_WORKER }
  if (env.PLATFORM_WORKER_URL) {
    return { kind: 'url', baseUrl: env.PLATFORM_WORKER_URL.replace(/\/$/, '') }
  }
  throw new Error(
    'platformWorkerFetch: neither env.PLATFORM_WORKER nor env.PLATFORM_WORKER_URL ' +
      'is set. Add a [[services]] binding in wrangler.toml for production, or let ' +
      '`deepspace dev` write PLATFORM_WORKER_URL into .dev.vars for local development.',
  )
}

/**
 * Build the URL/Request to send over a resolved transport.
 *
 * `path` may be a full URL (e.g. `https://api-worker/api/integrations`,
 * which inline call sites used historically) or a path-only string
 * (`/api/integrations`). Either way we extract `pathname + search` and
 * route it through the chosen transport.
 *
 *   - binding: keep an internal placeholder host. The Fetcher dispatches
 *     by binding, not host, so the host is purely cosmetic.
 *   - url: prefix with `transport.baseUrl`.
 */
function buildTargetUrl(transport: Transport, path: string, internalHost: string): string {
  let pathAndSearch: string
  if (path.startsWith('http://') || path.startsWith('https://')) {
    const u = new URL(path)
    pathAndSearch = u.pathname + u.search
  } else if (path.startsWith('/')) {
    pathAndSearch = path
  } else {
    pathAndSearch = '/' + path
  }

  if (transport.kind === 'binding') {
    return `https://${internalHost}${pathAndSearch}`
  }
  return `${transport.baseUrl}${pathAndSearch}`
}

/**
 * Fetch the api-worker. Prefers the `API_WORKER` service binding, falls
 * back to `API_WORKER_URL` over HTTPS.
 *
 * `path` is treated as path-only — any host in a passed-in URL is
 * stripped and replaced. This matches how `c.env.API_WORKER.fetch(...)`
 * already worked in the starter template (the host was always a
 * placeholder like `api-worker`).
 */
export function apiWorkerFetch(
  env: ApiWorkerEnv,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const transport = resolveApiTransport(env)
  const url = buildTargetUrl(transport, path, 'api-worker')
  if (transport.kind === 'binding') {
    return transport.fetcher.fetch(url, init as RequestInit)
  }
  return fetch(url, init)
}

/**
 * Fetch the platform-worker. Prefers the `PLATFORM_WORKER` service binding,
 * falls back to `PLATFORM_WORKER_URL` over HTTPS.
 *
 * Accepts a `Request` instance directly so callers can hand off
 * `c.req.raw`-derived requests with their original method/headers/body
 * intact. (`/api/files/*` does this — it forwards the caller's body
 * stream verbatim.)
 */
export function platformWorkerFetch(
  env: PlatformWorkerEnv,
  pathOrRequest: string | Request,
  init?: RequestInit,
): Promise<Response> {
  const transport = resolvePlatformTransport(env)

  if (typeof pathOrRequest === 'string') {
    const url = buildTargetUrl(transport, pathOrRequest, 'platform-worker')
    if (transport.kind === 'binding') {
      return transport.fetcher.fetch(url, init as RequestInit)
    }
    return fetch(url, init)
  }

  // Request instance: rewrite the URL through the chosen transport,
  // preserve method/headers/body from the original Request.
  const req = pathOrRequest
  const url = buildTargetUrl(transport, req.url, 'platform-worker')
  const rewritten = new Request(url, req)
  if (transport.kind === 'binding') {
    return transport.fetcher.fetch(rewritten)
  }
  return fetch(rewritten)
}

/**
 * Fetch the auth-worker over HTTPS. URL-only — there is no auth-worker
 * service binding, by design (we want plain-HTTP cookie semantics).
 *
 * Kept as a helper for surface symmetry with `apiWorkerFetch` /
 * `platformWorkerFetch`. Throws if `AUTH_WORKER_URL` is unset.
 */
export function authWorkerFetch(
  env: AuthWorkerEnv,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (!env.AUTH_WORKER_URL) {
    throw new Error(
      'authWorkerFetch: env.AUTH_WORKER_URL is not set. `deepspace dev` should ' +
        'write this into .dev.vars; for production, set it as a wrangler var or secret.',
    )
  }
  const baseUrl = env.AUTH_WORKER_URL.replace(/\/$/, '')

  let pathAndSearch: string
  if (path.startsWith('http://') || path.startsWith('https://')) {
    const u = new URL(path)
    pathAndSearch = u.pathname + u.search
  } else if (path.startsWith('/')) {
    pathAndSearch = path
  } else {
    pathAndSearch = '/' + path
  }

  return fetch(`${baseUrl}${pathAndSearch}`, init)
}
