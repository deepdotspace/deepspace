/** Platform calls that obtain app-scoped credentials for local execution. */

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
    const detail = await response.text().catch(() => '')
    throw new Error(`Failed to mint APP_OWNER_JWT (${response.status}): ${detail}`)
  }
  const body = (await response.json()) as { token?: string; error?: string }
  if (!body.token) {
    throw new Error(`Auth worker returned no token: ${body.error ?? 'unknown error'}`)
  }
  return body.token
}

/**
 * Fetch the app-origin identity token. A missing app is expected before its
 * first deployment and therefore returns null.
 */
export async function fetchAppIdentityToken(
  deployUrl: string,
  callerJwt: string,
  appId: string,
): Promise<string | null> {
  const response = await fetch(
    `${deployUrl}/api/apps/${encodeURIComponent(appId)}/identity-token`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${callerJwt}` },
    },
  )
  if (response.status === 404) return null
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Failed to fetch APP_IDENTITY_TOKEN (${response.status}): ${detail}`)
  }
  const body = (await response.json()) as { token?: string; error?: string }
  if (!body.token) {
    throw new Error(`Deploy worker returned no token: ${body.error ?? 'unknown error'}`)
  }
  return body.token
}
