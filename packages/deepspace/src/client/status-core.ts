export type LoadState = 'loading' | 'ready' | 'empty' | 'error' | 'signedOut'

export interface LoadStateAuthInput {
  isLoaded: boolean
  isSignedIn: boolean
  requireSignedIn?: boolean
  requireUser?: boolean
  userLoading?: boolean
}

export interface LoadStateStatusInput {
  status: 'loading' | 'ready' | 'error' | 'idle' | 'refreshing'
  error?: unknown
}

export interface DeriveLoadStateInput {
  auth?: LoadStateAuthInput
  queries?: LoadStateStatusInput[]
  resources?: LoadStateStatusInput[]
  empty?: boolean
}

export interface AsyncResourceDefaults {
  retry: number
  retryDelayMs: number
  slowAfterMs: number
}

export const ASYNC_RESOURCE_DEFAULTS: AsyncResourceDefaults = {
  retry: 0,
  retryDelayMs: 2_000,
  slowAfterMs: 10_000,
}

export function isAsyncResourceSlow(input: {
  startedAt: number
  now: number
  slowAfterMs: number
}): boolean {
  return input.slowAfterMs > 0 && input.now - input.startedAt >= input.slowAfterMs
}

export interface PagedResourceCooldownInput {
  failureCount: number
  retryDelayMs: number
  maxRetryDelayMs: number
}

export function getPagedResourceCooldownMs(input: PagedResourceCooldownInput): number {
  const failureCount = Math.max(1, input.failureCount)
  return Math.min(input.maxRetryDelayMs, input.retryDelayMs * 2 ** (failureCount - 1))
}

export function canAutoLoadPagedResource(input: {
  hasMore: boolean
  isLoading: boolean
  now: number
  cooldownUntil: number
}): boolean {
  return input.hasMore && !input.isLoading && input.cooldownUntil <= input.now
}

export function clampPagedResourceItems<T>(input: {
  items: T[]
  maxItemsPerPage: number
}): {
  items: T[]
  droppedItemCount: number
} {
  if (input.maxItemsPerPage <= 0 || input.items.length <= input.maxItemsPerPage) {
    return { items: input.items, droppedItemCount: 0 }
  }
  return {
    items: input.items.slice(0, input.maxItemsPerPage),
    droppedItemCount: input.items.length - input.maxItemsPerPage,
  }
}

export function deriveLoadState(input: DeriveLoadStateInput): LoadState {
  const auth = input.auth
  if (auth) {
    if (!auth.isLoaded) return 'loading'
    if (auth.requireSignedIn && !auth.isSignedIn) return 'signedOut'
    if (auth.requireUser && auth.isSignedIn && auth.userLoading) return 'loading'
  }

  const statuses = [...(input.queries ?? []), ...(input.resources ?? [])]
  if (statuses.some((item) => item.status === 'error' || item.error)) return 'error'
  if (statuses.some((item) => item.status === 'loading' || item.status === 'idle')) return 'loading'
  if (input.empty) return 'empty'
  return 'ready'
}
