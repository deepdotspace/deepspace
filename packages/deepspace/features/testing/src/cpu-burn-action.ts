/**
 * cpu-burn — server action that deliberately exceeds the dispatcher's
 * CPU limit so the e2e `testing.spec.ts` can assert that
 * `DEFAULT_LIMITS.cpuMs` on the dispatch worker actually fires.
 *
 * Runs a tight loop of hash computations until the runtime kills it. In
 * production this would be a denial-of-wallet event; in the testing
 * feature it's the whole point — we want the kill.
 *
 * The action returns only if CF *didn't* enforce the limit, which is
 * itself a test failure signal (hence the misleading `success: true`
 * — the spec asserts on the response status / outcome, not the body).
 */

import type { ActionHandler } from 'deepspace/worker'

interface OwnerEnv {
  OWNER_USER_ID?: string
}

export const cpuBurnAction: ActionHandler<OwnerEnv> = async (ctx) => {
  // Owner-only: the whole point of this action is to deliberately blow
  // the dispatcher's CPU cap, which burns real CF compute. Gate to the
  // app owner so a random authenticated user can't weaponize every
  // deployed app that installed the testing feature.
  const ownerId = ctx.env.OWNER_USER_ID
  if (ownerId && ctx.userId !== ownerId) {
    return { success: false, error: 'Forbidden: owner only' }
  }

  // Keep the loop tight and work-generating so v8 can't eliminate it as
  // dead code. Each iteration hashes a different value so the work
  // isn't constant-foldable.
  const encoder = new TextEncoder()
  let counter = 0n
  const deadline = Date.now() + 15_000 // safety: stop after 15s if CF didn't

  while (Date.now() < deadline) {
    const bytes = encoder.encode(`cpu-burn-${counter}`)
    await crypto.subtle.digest('SHA-256', bytes)
    counter += 1n
  }

  // If we got here, the dispatcher's limit did NOT fire — which is the
  // thing the spec is checking against. Return a marker so the failure
  // is diagnosable if the response ever makes it back.
  return {
    success: true,
    data: { iterations: counter.toString(), note: 'limit-did-not-fire' },
  }
}
