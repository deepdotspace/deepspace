/**
 * CLI session helpers — exchange a Better Auth session cookie for a short-lived
 * JWT against the auth worker. Shared by `auth.ts` (token refresh for all
 * authenticated commands) and `login.ts` (email/password flow).
 */

export const SESSION_COOKIE = '__Secure-better-auth.session_token'

/**
 * Exchange a Better Auth session token for a fresh JWT.
 * Returns null if the session is invalid or expired.
 */
export async function exchangeSession(
  authUrl: string,
  sessionToken: string,
): Promise<string | null> {
  const res = await fetch(`${authUrl}/api/auth/token`, {
    method: 'POST',
    headers: {
      Cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`,
      Origin: authUrl,
    },
  })
  if (!res.ok) return null
  const data = (await res.json()) as { token?: string | null }
  return data.token ?? null
}
