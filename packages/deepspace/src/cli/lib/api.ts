/**
 * Authenticated JSON fetch against a platform worker.
 *
 * Shared by the CLI commands that call the platform as the logged-in user
 * (`domain`, `feedback`, `collaborators`, `transfer`, …). Sends a Bearer
 * token, parses the JSON body, and on a non-2xx response throws an ApiError
 * carrying the worker's `{ error, code }` — message for display, code for
 * branching — so callers never string-sniff error text.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** Internal REST path — kept off the message (DEBUG-only rendering). */
    readonly apiPath?: string,
    /**
     * Structured fields the server sent alongside `error`/`code` — e.g. a
     * storage refusal's `usedBytes`/`limitBytes`. The command runtime spreads
     * these into the `--json` envelope, so a caller reads the numbers the API
     * already computed instead of parsing them back out of the sentence.
     */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
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
    // One transparent recovery per request. Safe for mutations too: every
    // repo-API mutation is idempotency-keyed, and the 401 means the server
    // never acted. Requires a NEW token — retrying the same rejected bearer
    // would just double the failure latency.
    if (res.status === 401 && !isRetry && refreshAuthToken) {
      const fresh = await refreshAuthToken()
      if (fresh && fresh !== token) return apiFetch<T>(baseUrl, fresh, path, init, true)
    }
    text = await res.text()
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
  if (!res.ok) {
    let msg = text
    let code: string | undefined
    try {
      const body = JSON.parse(text) as { error?: string; code?: string }
      msg = body.error ?? text
      code = body.code
    } catch {
      // not JSON
    }
    // A bare router 404 ("Not found", no server code) means DEEPSPACE_DEPLOY_URL
    // points at a service that doesn't host the repo API (wrong/old URL). Give it
    // an actionable message + code UNIFORMLY for every caller (incl. rollback's
    // direct endpoint), so a --json agent gets one stable slug for this case.
    if (!code && res.status === 404 && text.trim() === 'Not found') {
      code = 'unrecognized_service'
      msg = `The deploy service at ${baseUrl} doesn't recognize this request — check DEEPSPACE_DEPLOY_URL (is this the service the app lives on?); if it is, the server may be older than this CLI.`
    }
    // Any other server error that supplied no `code` of its own (a non-conforming
    // 5xx, an HTML error page) still needs a stable slug to classify.
    code = code ?? (res.status >= 500 ? 'server_error' : 'http_error')
    // Message = the server's sentence only. The internal REST path and raw
    // status read like a stack trace to users (same treatment as secretsApi);
    // they stay on the error's fields for DEBUG rendering and branching.
    throw new ApiError(msg || `Request failed (${res.status})`, res.status, code, path)
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
