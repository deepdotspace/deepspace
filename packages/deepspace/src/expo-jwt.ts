/**
 * Dependency-free JWT claim reading shared by the Expo client and
 * `deepspace/native`. Signatures are not verified here: the claims only decide
 * when to refresh a bearer and which user the app shows. The Worker verifies
 * every token it receives.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Decodes base64url to UTF-8 text without `atob`, which older React Native runtimes lack. */
export function decodeBase64Url(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of base64) {
    if (char === '=') break
    const value = BASE64_ALPHABET.indexOf(char)
    if (value < 0) throw new Error('Invalid base64url input')
    buffer = ((buffer << 6) | value) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(new Uint8Array(bytes))
  return decodeURIComponent(bytes.map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''))
}

/** The payload claims of a JWT, or null when it cannot be read. */
export function jwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const claims: unknown = JSON.parse(decodeBase64Url(payload))
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null
  } catch {
    return null
  }
}
