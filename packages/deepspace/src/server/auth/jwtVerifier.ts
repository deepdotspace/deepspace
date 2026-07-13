/**
 * JWT verification for DeepSpace workers.
 *
 * jose-based ES256 verification (jose runs on the Cloudflare Workers
 * edge runtime). Imported public keys are cached per-PEM to avoid
 * re-importing on every request, and `azp` is matched against an
 * optional list of authorized-party patterns supporting `*` wildcards.
 */

import { importSPKI, jwtVerify } from 'jose'
import type { JwtVerifierConfig, VerifyOutcome, JwtClaims } from './types'
import { decodeJwtPayload, normalizeArray } from './utils'

const DEFAULT_CLOCK_SKEW_MS = 5_000

/**
 * Check if azp matches any pattern in authorizedParties.
 * Supports wildcards like "https://*.app.space"
 */
function matchesAuthorizedParty(
  azp: string | null | undefined,
  patterns: string[],
): boolean {
  // Tokens without azp are valid (e.g., server-issued tokens)
  if (!azp) return true

  for (const pattern of patterns) {
    if (pattern === azp) return true

    if (pattern.includes('*')) {
      const escaped: string = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      const regexPattern: string = escaped.replace(/\*/g, '[^/]*')
      const regex: RegExp = new RegExp(`^${regexPattern}$`)
      if (regex.test(azp)) return true

      // "*.example.com" also allows "example.com"
      if (pattern.includes('*.')) {
        const rootPattern: string = pattern.replace('*.', '')
        if (rootPattern === azp) return true
      }
    }
  }

  return false
}

// Cache imported keys to avoid re-importing on every request
const keyCache = new Map<string, CryptoKey>()

async function getPublicKey(pem: string): Promise<CryptoKey> {
  const cached = keyCache.get(pem)
  if (cached) return cached
  // .dev.vars stores PEM with literal \n — replace with actual newlines
  const normalized = pem.replace(/\\n/g, '\n')
  const key = await importSPKI(normalized, 'ES256')
  keyCache.set(pem, key)
  return key
}

/**
 * Verify a DeepSpace JWT token.
 *
 * @param config - Verification configuration (public key, issuer, audience)
 * @param token - The JWT string to verify
 * @returns VerifyOutcome with either the verified result or error details
 */
export async function verifyJwt(
  config: JwtVerifierConfig,
  token: string | null | undefined,
): Promise<VerifyOutcome> {
  if (!token) {
    return { result: null }
  }

  try {
    const publicKey = await getPublicKey(config.publicKey)

    const audience = normalizeArray(config.audience)
    const clockTolerance = Math.floor(
      (config.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS) / 1000,
    )

    const { payload } = await jwtVerify(token, publicKey, {
      issuer: config.issuer,
      audience: audience && audience.length === 1 ? audience[0] : audience,
      clockTolerance,
    })

    const claims = payload as JwtClaims

    if (!claims.sub) {
      throw new Error('JWT verification succeeded but subject claim is missing')
    }

    // Check authorized parties if configured
    const authorizedParties = normalizeArray(config.authorizedParties)
    if (authorizedParties) {
      const azp = claims.azp
      if (!matchesAuthorizedParty(azp, authorizedParties)) {
        throw new Error(
          `Authorized party '${azp}' does not match any allowed pattern`,
        )
      }
    }

    return {
      result: {
        userId: claims.sub,
        claims,
      },
    }
  } catch (error) {
    return {
      result: null,
      error,
      debug: decodeJwtPayload(token),
    }
  }
}
