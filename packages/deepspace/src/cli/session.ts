/**
 * CLI session helpers — exchange a Better Auth session cookie for a short-lived
 * JWT against the auth worker. Shared by `auth.ts` (token refresh for all
 * authenticated commands) and `login.ts` (email/password flow).
 */

import { ApiError } from './lib/api'
import { fetchWithTransientRetry } from './lib/fetch-retry'

export const SESSION_COOKIE = '__Secure-better-auth.session_token'

/**
 * Exchange a Better Auth session token for a fresh JWT.
 * Returns null if the session is invalid or expired.
 */
export async function exchangeSession(
  authUrl: string,
  sessionToken: string,
): Promise<string | null> {
  const path = '/api/auth/token'
  let res: Response
  try {
    res = await fetchWithTransientRetry(
      `${authUrl}${path}`,
      () => ({
        method: 'POST',
        headers: {
          Cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`,
          Origin: authUrl,
        },
      }),
      { timeoutMs: 15_000 },
    )
  } catch (error) {
    throw new ApiError(
      `Could not reach the auth service at ${authUrl}: ${error instanceof Error ? error.message : String(error)}. Check your connection, then retry.`,
      0,
      'network_error',
      path,
    )
  }
  // This is the only response that proves the long-lived session is invalid.
  if (res.status === 401) return null
  if (!res.ok) {
    throw new ApiError(
      `The auth service could not refresh the CLI token (HTTP ${res.status}). Retry without logging in again.`,
      res.status,
      res.status === 429 ? 'rate_limited' : 'auth_service_unavailable',
      path,
    )
  }
  let data: { token?: string | null }
  try {
    data = (await res.json()) as { token?: string | null }
  } catch {
    throw new ApiError(
      'The auth service returned a malformed token response.',
      res.status,
      'invalid_response',
      path,
    )
  }
  if (!data.token) {
    throw new ApiError(
      'The auth service returned no token for a valid session.',
      res.status,
      'invalid_response',
      path,
    )
  }
  return data.token
}
