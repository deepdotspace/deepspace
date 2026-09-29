/** Pure URL helpers shared by the Expo auth client and its tests. */
export function buildExpoOAuthStartUrl(
  baseUrl: string,
  provider: string,
  redirectUri: string,
  state?: string,
  startPath = '/api/auth/native-start',
  codeChallenge?: string,
): string {
  const url = new URL(startPath, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  url.searchParams.set('provider', provider)
  url.searchParams.set('redirect_uri', redirectUri)
  if (state) url.searchParams.set('state', state)
  if (codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
  }
  return url.toString()
}

export function codeFromExpoRedirect(url: string): string | null {
  try {
    return new URL(url).searchParams.get('code')
  } catch {
    return null
  }
}

export function stateFromExpoRedirect(url: string): string | null {
  try {
    return new URL(url).searchParams.get('state')
  } catch {
    return null
  }
}

export function normalizeExpoBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}
