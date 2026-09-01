/**
 * Authenticated JSON fetch against a platform worker.
 *
 * Shared by the CLI commands that call the platform as the logged-in user
 * (`domain`, `feedback`, `collaborators`, `transfer`, …). Sends a Bearer
 * token, parses the JSON body, and on a non-2xx response throws an ApiError
 * carrying the worker's `{ error, code }` — message for display, code for
 * branching — so callers never string-sniff error text.
 */

import { displayLines } from './cli-format'
import { retryTransient } from './fetch-retry'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** Internal REST path — kept off the message (DEBUG-only rendering). */
    readonly apiPath?: string,
    /**
     * Structured fields the server sent alongside `error`/`code` — e.g. a
     * `merge_conflicted` path list, a storage refusal's `usedBytes`/
     * `limitBytes`. The failure envelope spreads these into `--json`, so a
     * caller reads the values the API already computed instead of parsing
     * them back out of the sentence.
     */
    readonly details?: Record<string, unknown>,
  ) {
    // Server prose reaches the terminal and the `--json` envelope through
    // `formatCliError`, which bypasses the Refusal/InputError exits entirely,
    // so this is the seam that escapes it — server sentences name branches,
    // paths and secret names that a peer chose.
    super(displayLines(message))
  }
}

/**
 * Registered by auth.ts at load: force-mint a fresh JWT from the stored
 * session, bypassing the cached token file. Lets apiFetch heal a 401 whose
 * cause is a token that is locally "valid" but rejected server-side (signing-
 * key rotation, revocation) with one silent refresh + retry instead of a hard
 * error an agent has to reason about. Null ⇒ the session itself is dead and
 * the original 401 stands. A callback (not an import) so this low-level
 * module stays dependency-free of auth.ts.
 */
let refreshAuthToken: (() => Promise<string | null>) | null = null
export function registerAuthRefresh(fn: () => Promise<string | null>): void {
  refreshAuthToken = fn
}

export async function apiFetch<T>(
  baseUrl: string,
  token: string,
  path: string,
  init?: RequestInit,
  isRetry = false,
): Promise<T> {
  let res: Response
  let text: string
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
  } catch (err) {
    // A network-level failure (connection refused, DNS, TLS, offline) throws a
    // TypeError('fetch failed'), not an HTTP status — give it a stable code so a
    // --json caller can classify the transport outage instead of scraping prose.
    throw new ApiError(
      `Could not reach the deploy service at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}. Check your connection (and DEEPSPACE_DEPLOY_URL), then retry.`,
      0,
      'network_error',
      path,
    )
  }
  // One transparent recovery per request. Keep the exchange outside the
  // deploy-service fetch catch: an auth-service outage is not evidence that
  // this bearer or the stored session is invalid, and must retain its code.
  if (res.status === 401 && !isRetry && refreshAuthToken) {
    const fresh = await refreshAuthToken()
    if (fresh && fresh !== token) return apiFetch<T>(baseUrl, fresh, path, init, true)
  }
  try {
    text = await res.text()
  } catch (err) {
    throw new ApiError(
      `Could not read the deploy service response at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}. Check your connection (and DEEPSPACE_DEPLOY_URL), then retry.`,
      0,
      'network_error',
      path,
    )
  }
  if (!res.ok) {
    let msg = text
    let code: string | undefined
    // Everything the refusal carried BESIDES its sentence and slug — e.g. the
    // GitHub-source 422's `repository`, a storage refusal's byte counts. The
    // server already computed them; dropping them here is what forced callers
    // to read numbers and names back out of the prose.
    let details: Record<string, unknown> | undefined
    try {
      const body = JSON.parse(text) as Record<string, unknown>
      if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        msg = typeof body.error === 'string' ? body.error : text
        code = typeof body.code === 'string' ? body.code : undefined
        const rest = Object.fromEntries(
          Object.entries(body).filter(([key]) => key !== 'error' && key !== 'code'),
        )
        if (Object.keys(rest).length > 0) details = rest
      }
    } catch {
      // not JSON
    }
    // A bare router 404 ("Not found", no server code) means DEEPSPACE_DEPLOY_URL
    // points at a service that doesn't host this route (wrong/old URL, or a
    // worker predating it). Give it an actionable message + code UNIFORMLY for
    // every caller (incl. rollback's direct endpoint), so a --json agent gets
    // one stable slug for this case. Matched on `msg`, not the raw body: the
    // worker's notFound handler answers JSON `{"error":"Not found"}`, so the
    // plain-text form alone misses the ACTUAL router 404 and leaves it coded
    // `http_error` — the generic slug every other 4xx already carries, so
    // nothing keyed on `unrecognized_service` can tell the cases apart.
    if (!code && res.status === 404 && msg.trim() === 'Not found') {
      code = 'unrecognized_service'
      msg = `The deploy service at ${baseUrl} doesn't recognize this request — check DEEPSPACE_DEPLOY_URL (is this the service the app lives on?); if it is, the server may be older than this CLI.`
    }
    // Any other server error that supplied no `code` of its own (a non-conforming
    // 5xx, an HTML error page) still needs a stable slug to classify.
    code = code ?? (res.status >= 500 ? 'server_error' : 'http_error')
    // Message = the server's sentence only. The internal REST path and raw
    // status read like a stack trace to users (same treatment as secretsApi);
    // they stay on the error's fields for DEBUG rendering and branching.
    throw new ApiError(msg || `Request failed (${res.status})`, res.status, code, path, details)
  }
  if (!text) return {} as T
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A 2xx with a non-JSON body isn't the repo API — code it so a --json caller
    // doesn't get a bare SyntaxError.
    throw new ApiError(
      `The deploy service at ${baseUrl} returned a malformed (non-JSON) response — check DEEPSPACE_DEPLOY_URL (is this the service the app lives on?).`,
      res.status,
      'invalid_response',
      path,
    )
  }
  // Every repo-API response is a JSON object; a null/array/primitive 2xx body is a
  // wrong/broken service — reject it with a code instead of letting a caller
  // destructure null and crash uncoded.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(
      `The deploy service at ${baseUrl} returned an unexpected response shape — check DEEPSPACE_DEPLOY_URL (is this the service the app lives on?).`,
      res.status,
      'invalid_response',
      path,
    )
  }
  return parsed as T
}

/** Retry a platform request whose caller has established that replay is safe.
 * Ordinary mutations keep using apiFetch directly; only read-only requests
 * and operations with an explicit idempotency contract belong here. */
export async function apiFetchWithTransientRetry<T>(
  baseUrl: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  return retryTransient(
    async () =>
      await apiFetch<T>(baseUrl, token, path, {
        ...init,
        signal: AbortSignal.timeout(15_000),
      }),
    {
      delaysMs: [250, 750, 1500],
      // A 401 refresh owns its own bounded auth-service retry loop. Only retry
      // failures produced by this deploy-service request, never multiply an
      // exhausted /api/auth/token exchange by replaying the rejected bearer.
      shouldRetryError: (error) => isTransientFailure(error) && error.apiPath === path,
    },
  )
}

/** Safe-by-construction GET variant for ordinary platform reads. */
export function apiFetchReadWithRetry<T>(baseUrl: string, token: string, path: string): Promise<T> {
  return apiFetchWithTransientRetry<T>(baseUrl, token, path)
}

function isTransientFailure(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500)
  )
}

/**
 * The public (unauthenticated) integration catalog, bounded and shape-checked.
 * One fetcher serves `deepspace integrations list/info/invoke` and the
 * repo-only integration-health scanner; `summary` selects the lightweight
 * names+billing view used by `list`. Throws ApiError with
 * `catalog_unavailable` (unreachable / non-2xx) or `invalid_catalog`
 * (unparseable / wrong envelope) for callers to map onto their own error
 * contracts.
 */
export async function fetchIntegrationCatalog<T extends { integrations: Record<string, unknown> }>(
  baseUrl: string,
  opts: { summary?: boolean } = {},
): Promise<T> {
  const path = opts.summary ? '/api/integrations?summary=1' : '/api/integrations'
  let res: Response
  try {
    res = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(15_000) })
  } catch (err) {
    throw new ApiError(
      `Could not fetch the integration catalog: ${err instanceof Error ? err.message : String(err)}`,
      0,
      'catalog_unavailable',
      path,
    )
  }
  if (!res.ok) {
    throw new ApiError(
      `Failed to fetch integration catalog (${res.status})`,
      res.status,
      'catalog_unavailable',
      path,
    )
  }
  let value: unknown
  try {
    value = await res.json()
  } catch {
    throw new ApiError(
      'The integration catalog returned invalid JSON.',
      res.status,
      'invalid_catalog',
      path,
    )
  }
  const integrations = (value as { integrations?: unknown } | null)?.integrations
  if (!integrations || typeof integrations !== 'object' || Array.isArray(integrations)) {
    throw new ApiError(
      'The integration catalog returned an invalid shape.',
      res.status,
      'invalid_catalog',
      path,
    )
  }
  return value as T
}
