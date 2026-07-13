/**
 * Auth types for the DeepSpace SDK.
 *
 * Provider-agnostic shapes for JWT verification (issuer, audience, azp
 * matching, ES256 public key) and the HMAC-signed internal-request
 * envelope used for worker-to-worker calls.
 */

// ============================================================================
// JWT Verification
// ============================================================================

export interface JwtVerifierConfig {
  /** PEM-encoded public key (ES256) for JWT verification */
  publicKey: string
  /** Expected issuer (e.g. "https://auth.deep.space/api/auth") */
  issuer: string
  /** Expected audience (usually the configured platform API URL) */
  audience?: string | string[]
  /** Allowed origins / authorized parties (supports wildcards like "https://*.app.space") */
  authorizedParties?: string[]
  /** Clock skew tolerance in milliseconds (default: 5000) */
  clockSkewMs?: number
}

export interface JwtClaims {
  sub: string
  iss?: string
  aud?: string | string[]
  azp?: string
  exp?: number
  iat?: number
  name?: string
  email?: string
  image?: string
  [key: string]: unknown
}

export interface VerifiedAuth {
  userId: string
  claims: JwtClaims
}

export type VerifyResult = VerifiedAuth

export interface TokenDebugInfo {
  iss?: string | null
  aud?: string | string[] | null
  azp?: string | null
  exp?: number | null
  iat?: number | null
}

export interface VerifyOutcome {
  result: VerifyResult | null
  debug?: TokenDebugInfo
  error?: unknown
}

