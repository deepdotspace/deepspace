import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './auth'
import { useUser } from './storage'
import {
  ASYNC_RESOURCE_DEFAULTS,
  canAutoLoadPagedResource,
  clampPagedResourceItems,
  deriveLoadState,
  getPagedResourceCooldownMs,
  isAsyncResourceSlow,
} from './status-core'

export {
  ASYNC_RESOURCE_DEFAULTS,
  canAutoLoadPagedResource,
  clampPagedResourceItems,
  deriveLoadState,
  getPagedResourceCooldownMs,
  isAsyncResourceSlow,
}
export type {
  AsyncResourceDefaults,
  DeriveLoadStateInput,
  LoadState,
  LoadStateAuthInput,
  LoadStateStatusInput,
} from './status-core'

export interface UseAuthStatusOptions {
  requireSignedIn?: boolean
}

export interface UseAuthProfileReadyOptions extends UseAuthStatusOptions {
  requireUser?: boolean
}

/** @deprecated Use `UseAuthProfileReadyOptions` instead. */
export type UseAuthReadyOptions = UseAuthProfileReadyOptions

export function useAuthStatus(options: UseAuthStatusOptions = {}) {
  const auth = useAuth()
  const status = deriveLoadState({
    auth: {
      isLoaded: auth.isLoaded,
      isSignedIn: auth.isSignedIn,
      requireSignedIn: options.requireSignedIn,
    },
  })

  return {
    ...auth,
    status,
    isReady: status === 'ready',
  }
}

export function useAuthProfileReady(options: UseAuthProfileReadyOptions = {}) {
  const auth = useAuth()
  const { user, isLoading: userLoading, refetch } = useUser()
  const status = deriveLoadState({
    auth: {
      isLoaded: auth.isLoaded,
      isSignedIn: auth.isSignedIn,
      requireSignedIn: options.requireSignedIn,
      requireUser: options.requireUser,
      userLoading,
    },
  })

  return {
    ...auth,
    user,
    userLoading,
    refetchUser: refetch,
    status,
    isReady: status === 'ready',
  }
}

/** @deprecated Use `useAuthStatus` for auth-only UI or `useAuthProfileReady` for profile-backed UI. */
export const useAuthReady = useAuthProfileReady

export type AsyncResourceStatus = 'idle' | 'loading' | 'ready' | 'error'
export type PagedResourceStatus = AsyncResourceStatus

export interface AsyncResourceState<T> {
  status: AsyncResourceStatus
  data: T | null
  error: string | null
  isRefreshing: boolean
  isSlow: boolean
  retryCount: number
}

export interface UseAsyncResourceOptions<T> {
  enabled?: boolean
  initialData?: T | null
  keepPreviousData?: boolean
  retry?: number
  retryDelayMs?: number
  slowAfterMs?: number
}

export interface PagedResourceFetchArgs {
  page: number
  pageSize: number
  signal: AbortSignal
}

export interface PagedResourcePage<T> {
  items: T[]
  hasMore?: boolean
}

export interface PagedResourceState<T> {
  status: PagedResourceStatus
  items: T[]
  error: string | null
  warning: string | null
  hasMore: boolean
  isLoadingInitial: boolean
  isLoadingMore: boolean
  isRefreshing: boolean
}

export interface UsePagedResourceOptions<T> {
  enabled?: boolean
  initialItems?: T[]
  pageSize?: number
  maxItemsPerPage?: number
  keepPreviousData?: boolean
  autoRetryOnError?: boolean
  retryDelayMs?: number
  maxRetryDelayMs?: number
}

export function useAsyncResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: UseAsyncResourceOptions<T> = {},
) {
  const enabled = options.enabled ?? true
  const keepPreviousData = options.keepPreviousData ?? true
  const retry = options.retry ?? ASYNC_RESOURCE_DEFAULTS.retry
  const retryDelayMs = options.retryDelayMs ?? ASYNC_RESOURCE_DEFAULTS.retryDelayMs
  const slowAfterMs = options.slowAfterMs ?? ASYNC_RESOURCE_DEFAULTS.slowAfterMs
  const [state, setState] = useState<AsyncResourceState<T>>(() => ({
    status: enabled ? 'loading' : 'idle',
    data: options.initialData ?? null,
    error: null,
    isRefreshing: false,
    isSlow: false,
    retryCount: 0,
  }))
  const requestIdRef = useRef(0)
  const [reloadTick, setReloadTick] = useState(0)

  const reload = useCallback(() => {
    setReloadTick((tick) => tick + 1)
  }, [])

  useEffect(() => {
    if (!enabled) {
      setState((prev) => ({ ...prev, status: 'idle', isRefreshing: false, isSlow: false, retryCount: 0 }))
      return
    }

    const requestId = ++requestIdRef.current
    const controller = new AbortController()
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let slowTimer: ReturnType<typeof setTimeout> | null = null

    setState((prev) => {
      const hasData = keepPreviousData && prev.data != null
      return {
        ...prev,
        status: hasData ? 'ready' : 'loading',
        error: null,
        isRefreshing: hasData,
        isSlow: false,
        data: hasData ? prev.data : (options.initialData ?? null),
        retryCount: 0,
      }
    })

    if (slowAfterMs > 0) {
      const startedAt = Date.now()
      slowTimer = setTimeout(() => {
        if (requestIdRef.current !== requestId || controller.signal.aborted) return
        setState((prev) => ({
          ...prev,
          isSlow: isAsyncResourceSlow({ startedAt, now: Date.now(), slowAfterMs }),
        }))
      }, slowAfterMs)
    }

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        retryTimer = setTimeout(resolve, ms)
      })

    const load = async () => {
      let attempt = 0
      while (!controller.signal.aborted) {
        try {
          const data = await fetcher(controller.signal)
          if (requestIdRef.current !== requestId || controller.signal.aborted) return
          if (slowTimer) clearTimeout(slowTimer)
          setState({ status: 'ready', data, error: null, isRefreshing: false, isSlow: false, retryCount: attempt })
          return
        } catch (err: unknown) {
          if (requestIdRef.current !== requestId || controller.signal.aborted) return
          const message = err instanceof Error ? err.message : 'Request failed'
          if (attempt < retry) {
            attempt += 1
            setState((prev) => ({
              ...prev,
              error: message,
              retryCount: attempt,
              isRefreshing: keepPreviousData && prev.data != null,
            }))
            await wait(retryDelayMs)
            continue
          }

          if (slowTimer) clearTimeout(slowTimer)
          setState((prev) => ({
            status: keepPreviousData && prev.data != null ? 'ready' : 'error',
            data: keepPreviousData ? prev.data : null,
            error: message,
            isRefreshing: false,
            isSlow: false,
            retryCount: attempt,
          }))
          return
        }
      }
    }

    load()

    return () => {
      if (retryTimer) clearTimeout(retryTimer)
      if (slowTimer) clearTimeout(slowTimer)
      controller.abort()
    }
    // Deps are the caller-supplied ...deps plus the primitive options; the
    // inline load() closure (and fetcher/options.initialData it captures) is
    // deliberately not listed to avoid re-running the fetch/retry lifecycle on
    // every render (which would cause request storms).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-supplied ...deps is the re-fetch contract; inline load()/fetcher excluded to avoid request storms
  }, [enabled, keepPreviousData, retry, retryDelayMs, slowAfterMs, reloadTick, ...deps])

  return useMemo(() => ({ ...state, reload }), [state, reload])
}

export function usePagedResource<T>(
  fetchPage: (args: PagedResourceFetchArgs) => Promise<PagedResourcePage<T>>,
  deps: readonly unknown[],
  options: UsePagedResourceOptions<T> = {},
) {
  const enabled = options.enabled ?? true
  const initialItems = options.initialItems ?? []
  const pageSize = options.pageSize ?? 20
  const maxItemsPerPage = options.maxItemsPerPage ?? pageSize
  const keepPreviousData = options.keepPreviousData ?? true
  const autoRetryOnError = options.autoRetryOnError ?? false
  const retryDelayMs = options.retryDelayMs ?? ASYNC_RESOURCE_DEFAULTS.retryDelayMs
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000
  const hasInitialItems = initialItems.length > 0
  const [state, setState] = useState<PagedResourceState<T>>(() => ({
    status: enabled ? (hasInitialItems ? 'ready' : 'loading') : 'idle',
    items: initialItems,
    error: null,
    warning: null,
    hasMore: true,
    isLoadingInitial: enabled && !hasInitialItems,
    isLoadingMore: false,
    isRefreshing: false,
  }))
  const requestIdRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const loadingRef = useRef(false)
  const nextPageRef = useRef(hasInitialItems ? 2 : 1)
  const failedPageRef = useRef<number | null>(null)
  const failureCountRef = useRef(0)
  const cooldownUntilRef = useRef(0)
  const autoRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearAutoRetryTimer = useCallback(() => {
    if (autoRetryTimerRef.current) {
      clearTimeout(autoRetryTimerRef.current)
      autoRetryTimerRef.current = null
    }
  }, [])

  const resetCooldown = useCallback(() => {
    failureCountRef.current = 0
    cooldownUntilRef.current = 0
  }, [])

  const setFailureCooldown = useCallback(() => {
    failureCountRef.current += 1
    const delay = getPagedResourceCooldownMs({
      failureCount: failureCountRef.current,
      retryDelayMs,
      maxRetryDelayMs,
    })
    cooldownUntilRef.current = Date.now() + delay
    return delay
  }, [maxRetryDelayMs, retryDelayMs])

  const startLoad = useCallback(async (page: number, mode: 'auto' | 'manual' | 'refresh') => {
    if (!enabled || loadingRef.current) return
    if (
      mode === 'auto' &&
      !canAutoLoadPagedResource({
        hasMore: true,
        isLoading: false,
        now: Date.now(),
        cooldownUntil: cooldownUntilRef.current,
      })
    ) {
      return
    }

    clearAutoRetryTimer()
    loadingRef.current = true
    const requestId = ++requestIdRef.current
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller

    setState((prev) => {
      const hasItems = prev.items.length > 0
      return {
        ...prev,
        status: hasItems && mode !== 'refresh' ? 'ready' : 'loading',
        error: mode === 'auto' && prev.error ? prev.error : null,
        warning: null,
        isLoadingInitial: !hasItems && mode !== 'refresh',
        isLoadingMore: hasItems && mode !== 'refresh',
        isRefreshing: mode === 'refresh' && hasItems,
        items: mode === 'refresh' && !keepPreviousData ? [] : prev.items,
      }
    })

    try {
      const result = await fetchPage({ page, pageSize, signal: controller.signal })
      if (requestIdRef.current !== requestId || controller.signal.aborted) return
      const { items: pageItems, droppedItemCount } = clampPagedResourceItems({
        items: result.items,
        maxItemsPerPage,
      })
      resetCooldown()
      failedPageRef.current = null
      nextPageRef.current = page + 1
      setState((prev) => ({
        status: 'ready',
        items: page === 1 || mode === 'refresh'
          ? pageItems
          : [...prev.items, ...pageItems],
        error: null,
        warning: droppedItemCount > 0
          ? `The last API page returned ${result.items.length} items; only ${pageItems.length} were kept. Request a smaller page from the API instead of fetching the whole feed.`
          : null,
        hasMore: droppedItemCount > 0 || (result.hasMore ?? result.items.length >= pageSize),
        isLoadingInitial: false,
        isLoadingMore: false,
        isRefreshing: false,
      }))
    } catch (err: unknown) {
      if (requestIdRef.current !== requestId || controller.signal.aborted) return
      const message = err instanceof Error ? err.message : 'Request failed'
      failedPageRef.current = page
      const cooldownMs = setFailureCooldown()
      setState((prev) => {
        const hasItems = prev.items.length > 0
        return {
          ...prev,
          status: hasItems ? 'ready' : 'error',
          error: message,
          warning: prev.warning,
          hasMore: hasItems ? prev.hasMore : false,
          isLoadingInitial: false,
          isLoadingMore: false,
          isRefreshing: false,
        }
      })
      if (autoRetryOnError) {
        autoRetryTimerRef.current = setTimeout(() => {
          autoRetryTimerRef.current = null
          void startLoad(page, 'auto')
        }, cooldownMs)
      }
    } finally {
      if (requestIdRef.current === requestId) {
        loadingRef.current = false
        controllerRef.current = null
      }
    }
  }, [autoRetryOnError, clearAutoRetryTimer, enabled, fetchPage, keepPreviousData, maxItemsPerPage, pageSize, resetCooldown, setFailureCooldown])

  const loadMore = useCallback(() => {
    if (!state.hasMore || state.isLoadingInitial || state.isLoadingMore || state.isRefreshing) return
    void startLoad(nextPageRef.current, 'auto')
  }, [startLoad, state.hasMore, state.isLoadingInitial, state.isLoadingMore, state.isRefreshing])

  const retry = useCallback(() => {
    const page = failedPageRef.current ?? nextPageRef.current
    void startLoad(page, 'manual')
  }, [startLoad])

  const refresh = useCallback(() => {
    failedPageRef.current = null
    resetCooldown()
    nextPageRef.current = 1
    void startLoad(1, 'refresh')
  }, [resetCooldown, startLoad])

  useEffect(() => {
    requestIdRef.current += 1
    controllerRef.current?.abort()
    clearAutoRetryTimer()
    loadingRef.current = false
    failedPageRef.current = null
    resetCooldown()
    nextPageRef.current = hasInitialItems ? 2 : 1

    setState({
      status: enabled ? (hasInitialItems ? 'ready' : 'loading') : 'idle',
      items: initialItems,
      error: null,
      warning: null,
      hasMore: true,
      isLoadingInitial: enabled && !hasInitialItems,
      isLoadingMore: false,
      isRefreshing: false,
    })

    if (enabled && !hasInitialItems) {
      void startLoad(1, 'auto')
    }

    return () => {
      requestIdRef.current += 1
      controllerRef.current?.abort()
      clearAutoRetryTimer()
      loadingRef.current = false
    }
    // Deps are the caller-supplied ...deps plus the primitive options; the
    // startLoad closure and refs are deliberately excluded so this reset effect
    // only re-runs on real dependency changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-supplied ...deps is the reset contract; startLoad/refs/initialItems excluded so reset only fires on real dep changes
  }, [enabled, pageSize, maxItemsPerPage, keepPreviousData, autoRetryOnError, retryDelayMs, maxRetryDelayMs, ...deps])

  return useMemo(() => ({
    ...state,
    loadMore,
    retry,
    refresh,
  }), [loadMore, refresh, retry, state])
}
