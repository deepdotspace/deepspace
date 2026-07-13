import { describe, expect, it } from 'vitest'
import {
  ASYNC_RESOURCE_DEFAULTS,
  canAutoLoadPagedResource,
  clampPagedResourceItems,
  deriveLoadState,
  getPagedResourceCooldownMs,
  isAsyncResourceSlow,
} from '../status-core'

describe('deriveLoadState', () => {
  it('waits for auth to resolve before rendering dependent UI', () => {
    expect(deriveLoadState({
      auth: { isLoaded: false, isSignedIn: false, requireSignedIn: true },
    })).toBe('loading')
  })

  it('returns signedOut when a signed-in session is required', () => {
    expect(deriveLoadState({
      auth: { isLoaded: true, isSignedIn: false, requireSignedIn: true },
    })).toBe('signedOut')
  })

  it('waits for the user profile when profile-backed UI is required', () => {
    expect(deriveLoadState({
      auth: {
        isLoaded: true,
        isSignedIn: true,
        requireSignedIn: true,
        requireUser: true,
        userLoading: true,
      },
    })).toBe('loading')
  })

  it('does not wait for the user profile for auth-only UI', () => {
    expect(deriveLoadState({
      auth: {
        isLoaded: true,
        isSignedIn: true,
        requireSignedIn: true,
        requireUser: false,
        userLoading: true,
      },
    })).toBe('ready')
  })

  it('prioritizes query and resource errors over empty states', () => {
    expect(deriveLoadState({
      queries: [{ status: 'ready' }],
      resources: [{ status: 'error', error: 'boom' }],
      empty: true,
    })).toBe('error')
  })

  it('waits for all queries and resources to reach a terminal state', () => {
    expect(deriveLoadState({
      queries: [{ status: 'ready' }],
      resources: [{ status: 'loading' }],
    })).toBe('loading')
  })

  it('returns empty only when the caller explicitly marks the view empty', () => {
    expect(deriveLoadState({
      queries: [{ status: 'ready' }],
      resources: [{ status: 'ready' }],
      empty: true,
    })).toBe('empty')
  })

  it('returns ready when auth, queries, and resources are ready', () => {
    expect(deriveLoadState({
      auth: { isLoaded: true, isSignedIn: true, requireSignedIn: true },
      queries: [{ status: 'ready' }],
      resources: [{ status: 'ready' }],
    })).toBe('ready')
  })
})

describe('async resource defaults', () => {
  it('does not automatically retry resource loads unless callers opt in', () => {
    expect(ASYNC_RESOURCE_DEFAULTS.retry).toBe(0)
  })

  it('keeps a bounded retry delay for explicit retry opt-in', () => {
    expect(ASYNC_RESOURCE_DEFAULTS.retryDelayMs).toBe(2_000)
  })

  it('marks long-running resources slow after a bounded threshold', () => {
    expect(ASYNC_RESOURCE_DEFAULTS.slowAfterMs).toBe(10_000)
    expect(isAsyncResourceSlow({
      startedAt: 1_000,
      now: 10_999,
      slowAfterMs: ASYNC_RESOURCE_DEFAULTS.slowAfterMs,
    })).toBe(false)
    expect(isAsyncResourceSlow({
      startedAt: 1_000,
      now: 11_000,
      slowAfterMs: ASYNC_RESOURCE_DEFAULTS.slowAfterMs,
    })).toBe(true)
  })

  it('does not mark a resource slow when the slow threshold is disabled', () => {
    expect(isAsyncResourceSlow({
      startedAt: 1_000,
      now: 60_000,
      slowAfterMs: 0,
    })).toBe(false)
  })
})

describe('paged resource cooldown policy', () => {
  it('backs off repeated automatic page-load failures up to a cap', () => {
    expect(getPagedResourceCooldownMs({
      failureCount: 1,
      retryDelayMs: 500,
      maxRetryDelayMs: 5_000,
    })).toBe(500)

    expect(getPagedResourceCooldownMs({
      failureCount: 4,
      retryDelayMs: 500,
      maxRetryDelayMs: 5_000,
    })).toBe(4_000)

    expect(getPagedResourceCooldownMs({
      failureCount: 8,
      retryDelayMs: 500,
      maxRetryDelayMs: 5_000,
    })).toBe(5_000)
  })

  it('blocks automatic load-more calls while loading or cooling down', () => {
    expect(canAutoLoadPagedResource({
      hasMore: true,
      isLoading: false,
      now: 1_000,
      cooldownUntil: 1_000,
    })).toBe(true)

    expect(canAutoLoadPagedResource({
      hasMore: true,
      isLoading: true,
      now: 1_000,
      cooldownUntil: 1_000,
    })).toBe(false)

    expect(canAutoLoadPagedResource({
      hasMore: true,
      isLoading: false,
      now: 1_000,
      cooldownUntil: 2_000,
    })).toBe(false)

    expect(canAutoLoadPagedResource({
      hasMore: false,
      isLoading: false,
      now: 2_000,
      cooldownUntil: 1_000,
    })).toBe(false)
  })

  it('clamps oversized API pages so feeds do not retain entire endpoints', () => {
    const result = clampPagedResourceItems({
      items: Array.from({ length: 500 }, (_, index) => index),
      maxItemsPerPage: 20,
    })

    expect(result.items).toHaveLength(20)
    expect(result.items[0]).toBe(0)
    expect(result.items[19]).toBe(19)
    expect(result.droppedItemCount).toBe(480)
  })

  it('allows explicit opt-out from page clamping', () => {
    const items = [1, 2, 3]
    expect(clampPagedResourceItems({ items, maxItemsPerPage: 0 })).toEqual({
      items,
      droppedItemCount: 0,
    })
  })
})
