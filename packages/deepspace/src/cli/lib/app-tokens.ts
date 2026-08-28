/** Platform calls that obtain app-scoped credentials for local execution.
 *  HTTP refusals are ApiError (status + server code preserved) so callers
 *  can classify — the deploy path's friendly not-authorized message matches
 *  on `status === 403`, which a plain Error silently defeated. (Malformed
 *  200s — missing token/publicKey — still throw plain Errors: there is no
 *  status to classify on.) */

import { ApiError } from './api'

/** The platform's `{error, code}` refusal body when parseable, else raw text. */
async function refusalDetail(response: Response): Promise<{ detail: string; code?: string }> {
  const text = await response.text().catch(() => '')
  try {
    const body = JSON.parse(text) as { error?: string; code?: string }
    return { detail: body.error ?? text, code: body.code }
  } catch {
    return { detail: text }
  }
}

/** Fetch the JWT public key from an auth worker's JWKS endpoint. */
export async function fetchPublicKey(authUrl: string): Promise<string> {
  const response = await fetch(`${authUrl}/api/auth/jwks`)
  if (!response.ok) {
    throw new Error(`Failed to fetch JWT public key (${response.status})`)
  }
  const body = (await response.json()) as { publicKey?: string }
  if (!body.publicKey) throw new Error('JWKS response missing publicKey')
  return body.publicKey
}

/** Mint a long-lived owner token bound to the app's immutable id. */
export async function mintAppOwnerJwt(
  authUrl: string,
  callerJwt: string,
  appId: string,
): Promise<string> {
  const response = await fetch(`${authUrl}/api/auth/mint-app-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${callerJwt}`,
    },
    body: JSON.stringify({ appId }),
  })
  if (!response.ok) {
    const { detail, code } = await refusalDetail(response)
    throw new ApiError(
      `Failed to mint APP_OWNER_JWT (${response.status}): ${detail}`,
      response.status,
      code,
      '/api/auth/mint-app-token',
    )
  }
  const body = (await response.json()) as { token?: string; error?: string }
  if (!body.token) {
    throw new Error(`Auth worker returned no token: ${body.error ?? 'unknown error'}`)
  }
  return body.token
}

/**
 * Fetch the app-origin identity token. Registration happens at `app init`
 * (server-side mint), so an id the platform cannot resolve is WRONG — a
 * different environment's id, or a hand-edited wrangler.toml — never "not
 * deployed yet" (that era's first-touch registration is gone). Refusing
 * loudly here is what keeps `dev start` from writing a .dev.vars with no
 * APP_IDENTITY_TOKEN, where every platform call then fails verification at
 * runtime with nothing ever printed.
 */
export async function fetchAppIdentityToken(
  deployUrl: string,
  callerJwt: string,
  appId: string,
): Promise<string> {
  const response = await fetch(
    `${deployUrl}/api/apps/${encodeURIComponent(appId)}/identity-token`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${callerJwt}` },
    },
  )
  if (response.status === 404) {
    const { detail, code } = await refusalDetail(response)
    // Only the registry's own answer earns the confident diagnosis — a 404
    // from a wrong DEEPSPACE_DEPLOY_URL (no such route) must not tell the
    // user their perfectly valid app id doesn't exist.
    if (code === 'app_not_found') {
      throw new ApiError(
        // No executable command in this prose: this lib cannot know the
        // wrangler env, and a bare `app init` under --env would target the
        // TOP-LEVEL [vars] slot. dev/test/deploy attach the env-aware
        // remedy as a structured action; surfaces without an action channel
        // (secrets pull among them) fall back to the
        // app_not_found hint (check the id / `deepspace app list`).
        `App ${appId} is not registered on this platform — DEEPSPACE_APP_ID may belong to a ` +
          'different environment (a staging id does not exist on prod, and vice versa), or the ' +
          'app was never initialized here.',
        404,
        code,
        `/api/apps/${appId}/identity-token`,
      )
    }
    throw new ApiError(
      `Failed to fetch APP_IDENTITY_TOKEN (404): ${detail || 'no such route'} — is ` +
        'DEEPSPACE_DEPLOY_URL pointing at the right deploy service?',
      404,
      code,
      `/api/apps/${appId}/identity-token`,
    )
  }
  if (!response.ok) {
    const { detail, code } = await refusalDetail(response)
    throw new ApiError(
      `Failed to fetch APP_IDENTITY_TOKEN (${response.status}): ${detail}`,
      response.status,
      code,
      `/api/apps/${appId}/identity-token`,
    )
  }
  const body = (await response.json()) as { token?: string; error?: string }
  if (!body.token) {
    throw new Error(`Deploy worker returned no token: ${body.error ?? 'unknown error'}`)
  }
  return body.token
}
