/**
 * App-identity headers for platform calls (api-worker, platform-worker).
 *
 * The pair is `x-app-identity-token` (HMAC(PLATFORM_IDENTITY_SECRET, appId),
 * minted at deploy time and injected as a binding) + `x-app-id`. Pre-first-
 * deploy the token binding is ABSENT — `deepspace dev` can only fetch it once
 * the app is in the deploy registry. Attaching headers built from an undefined
 * binding sends the literal string "undefined", which upstream identity
 * verification rejects as a *tampered* token (401 invalid) instead of the
 * truthful "missing app identity" — so this helper fails closed by attaching
 * nothing when the token is unset. The starter's worker.ts proxies follow the
 * same policy (see reassertAppIdentity there).
 */

export interface AppIdentityEnv {
  /** The app's immutable id (wrangler.toml [vars] DEEPSPACE_APP_ID). */
  DEEPSPACE_APP_ID: string
  /** Absent until the app's first deploy registers it. */
  APP_IDENTITY_TOKEN?: string
}

/**
 * Append the app's identity pair to `headers`, fail-closed: no token → no
 * identity headers, so the upstream answers "missing app identity" rather
 * than rejecting a garbage token.
 */
export function appendAppIdentity(headers: Headers, env: AppIdentityEnv): void {
  // Sanitize first so forwarded request headers can never smuggle identity —
  // same policy as the starter worker's reassertAppIdentity.
  headers.delete('x-app-identity-token')
  headers.delete('x-app-id')
  if (!env.APP_IDENTITY_TOKEN) return
  headers.set('x-app-identity-token', env.APP_IDENTITY_TOKEN)
  headers.set('x-app-id', env.DEEPSPACE_APP_ID)
}
