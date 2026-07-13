/**
 * Test-account identification, shared by every platform worker.
 *
 * Test accounts (created via `deepspace test-accounts`) are real Better Auth
 * users demarcated three ways, and a caller may present as any of them
 * depending on where the check runs:
 *  - their email always ends with @deepspace.test (enforced at creation)
 *  - their JWTs carry `isTestAccount: true` (minted by the auth-worker,
 *    the source of truth)
 *  - their billing profile's subscription tier is 'test' (mirrored by the
 *    api-worker on every authenticated request)
 *
 * Gate anything a test account must not do with these helpers rather than
 * hand-rolled string comparisons, so the policy stays in one place. Prefer
 * checking the claim when a verified JWT is at hand, and the tier as the
 * fallback for persisted state that may outlive a claim (e.g. rows written
 * before a guard existed).
 */

import type { JwtClaims } from './types'

export const TEST_ACCOUNT_EMAIL_SUFFIX = '@deepspace.test'

/** True when the email belongs to a test account (case-insensitive). */
export function isTestAccountEmail(email: string | null | undefined): boolean {
  return !!email && email.trim().toLowerCase().endsWith(TEST_ACCOUNT_EMAIL_SUFFIX)
}

/** True when verified JWT claims identify the caller as a test account. */
export function isTestAccountClaims(
  claims: JwtClaims | Record<string, unknown> | null | undefined,
): boolean {
  return claims?.isTestAccount === true
}

/** True when a billing subscription tier marks a test account. */
export function isTestAccountTier(tier: string | null | undefined): boolean {
  return tier === 'test'
}
