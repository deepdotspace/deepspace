/**
 * Deployed-app quota defaults — the ONE copy.
 *
 * Two workers use these numbers for different jobs: the deploy worker
 * ENFORCES them at registration time, the api worker DISPLAYS them via
 * GET /api/plan-limits. They used to be independent literal sets (plus the
 * same numbers again in six wrangler [vars] blocks as overrides) and had
 * already diverged once — the display copy was missing the admin tier
 * entirely. The env vars remain the per-plane override mechanism; only the
 * fallbacks live here.
 */
export const DEPLOYED_APPS_DEFAULTS = {
  free: 1,
  starter: 4,
  premium: 10,
  admin: 100,
} as const

/** Parse a quota env override; anything non-integer/negative = fallback. */
export function parseQuotaLimit(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}
