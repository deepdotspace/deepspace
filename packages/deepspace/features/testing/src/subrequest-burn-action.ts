/**
 * subrequest-burn — server action that fires more outbound fetches than
 * the dispatcher's `DEFAULT_LIMITS.subRequests` allows, so the e2e
 * `testing.spec.ts` can assert the subRequests cap actually enforces.
 *
 * Hits the platform-worker health endpoint 60 times (cap is 50). The
 * 51st subrequest should fail inside the user worker.
 *
 * Platform-worker is an internal service binding — no public network
 * egress, no third-party rate-limit headaches.
 */

import type { ActionHandler } from 'deepspace/worker'

interface OwnerEnv {
  OWNER_USER_ID?: string
}

export const subrequestBurnAction: ActionHandler<OwnerEnv> = async (ctx) => {
  // Owner-only — same reasoning as cpu-burn. Without this guard any
  // authenticated user could force our dispatcher to emit 50 outbound
  // fetches on command.
  const ownerId = ctx.env.OWNER_USER_ID
  if (ownerId && ctx.userId !== ownerId) {
    return { success: false, error: 'Forbidden: owner only' }
  }

  // Target is an arbitrary URL — the test passes `https://example.com`
  // but callers could point at an internal endpoint too. Fixed fallback
  // so the spec works even when params aren't supplied.
  const target = (ctx.params.target as string | undefined) ?? 'https://example.com'
  const count = Math.max(1, Math.min(60, (ctx.params.count as number | undefined) ?? 60))

  let completed = 0
  let lastError: string | null = null
  try {
    for (let i = 0; i < count; i++) {
      const res = await fetch(`${target}?i=${i}`, { method: 'GET' })
      // Drain the body so the subrequest actually completes.
      await res.arrayBuffer()
      completed++
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
  }

  // The action itself always succeeds — it ran the experiment. Whether the
  // dispatcher's subRequests cap fired is reported in `data`: `completed <
  // attempted` means it fired (the desired outcome), `completed === attempted`
  // means it didn't (a test-failure signal). Mirrors cpu-burn, which likewise
  // returns success:true with a diagnostic payload.
  return {
    success: true,
    data: { attempted: count, completed, lastError },
  }
}
