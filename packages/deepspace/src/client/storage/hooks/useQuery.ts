/**
 * useQuery Hook
 *
 * Subscribe to a query with real-time updates.
 * Resolves the correct scope via ScopeRegistry (multi-scope)
 * or falls back to useRecordContext() (single-scope backward compat).
 */

import { useEffect, useCallback, useRef, useMemo, useContext, useSyncExternalStore } from 'react'
import { RecordContext } from '../context'
import { useScopeRegistry } from '../ScopeRegistry'
import type { Query, RecordData } from '../types'
import { MSG } from '@/shared/protocol/constants'

/**
 * Subscribe to a query with real-time updates.
 *
 * @example
 * ```tsx
 * const { records, status } = useQuery('tasks', {
 *   where: { userId: me },
 *   orderBy: 'createdAt',
 *   orderDir: 'desc',
 *   limit: 50
 * })
 * ```
 */
export function useQuery<T = unknown>(
  collection: string,
  options?: {
    where?: Record<string, unknown>
    orderBy?: string
    orderDir?: 'asc' | 'desc'
    limit?: number
  },
): {
  records: RecordData<T>[]
  status: 'loading' | 'ready' | 'error'
  error?: string
} {
  // Try scope resolution first (multi-scope), then fall back to RecordContext
  const registry = useScopeRegistry()
  const recordCtx = useContext(RecordContext)

  const scopeEntry = registry?.resolve(collection) ?? null

  // Prefer RecordContext when this scope handles the collection (avoids stale ScopeRegistry during navigation)
  const preferLocal = recordCtx?.registeredCollections?.has(collection) ?? false
  const store = preferLocal ? recordCtx!.store : (scopeEntry?.store ?? recordCtx?.store)
  const sendMessage = preferLocal
    ? recordCtx!.sendMessage
    : (scopeEntry?.sendMessage ?? recordCtx?.sendMessage)
  const registerSub = preferLocal
    ? recordCtx!.registerSubscription
    : (scopeEntry?.registerSubscription ?? recordCtx?.registerSubscription)
  const unregisterSub = preferLocal
    ? recordCtx!.unregisterSubscription
    : (scopeEntry?.unregisterSubscription ?? recordCtx?.unregisterSubscription)

  if (!store || !sendMessage || !registerSub || !unregisterSub) {
    throw new Error(
      `useQuery('${collection}'): No scope found. Wrap in a RecordProvider (with roomId) or a RecordScope that registers this collection.`,
    )
  }

  const optionsKey = JSON.stringify(options ?? null)

  const query: Query = useMemo(
    () => ({
      collection,
      where: options?.where,
      orderBy: options?.orderBy,
      orderDir: options?.orderDir,
      limit: options?.limit,
      // Keyed by the serialized optionsKey rather than the raw options object
      // (a fresh object each render) so the query — and its WS subscription —
      // is only rebuilt when the options actually change.
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on serialized optionsKey, not raw options.where/orderBy/orderDir/limit objects, to avoid rebuilding the WS subscription every render
    [collection, optionsKey],
  )

  const queryKey = useMemo(() => JSON.stringify(query), [query])

  const subscriptionIdRef = useRef<string>(
    `sub-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )

  useEffect(() => {
    const subscriptionId = subscriptionIdRef.current

    const isFirst = store.initQuery(queryKey)

    if (isFirst) {
      store.setSubscriptionId(queryKey, subscriptionId)
      registerSub(subscriptionId, queryKey)
      sendMessage({ type: MSG.SUBSCRIBE, payload: { subscriptionId, query } })
    }

    return () => {
      const activeSubId = store.getSubscriptionId(queryKey) ?? subscriptionId
      const isLast = store.releaseQuery(queryKey)

      if (isLast) {
        sendMessage({ type: MSG.UNSUBSCRIBE, payload: { subscriptionId: activeSubId } })
        unregisterSub(activeSubId)
      }
    }
  }, [queryKey, query, store, sendMessage, registerSub, unregisterSub, collection])

  const subscribe = useCallback(
    (onStoreChange: () => void) => store.subscribe(queryKey, onStoreChange),
    [store, queryKey],
  )

  const getSnapshot = useCallback(() => store.getSnapshot(queryKey), [store, queryKey])

  // The snapshot bundles records + status + error, so a transition in any of
  // them (e.g. an error before the first result) re-renders. Reading them off
  // the store separately would miss those transitions when `records` is
  // reference-stable.
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const records = snapshot.records as RecordData<T>[]
  const { status, error } = snapshot

  // Memoize the return object so consumers get a stable reference
  // (same rationale as useMutations — prevents spurious effect re-runs).
  return useMemo(() => ({ records, status, error }), [records, status, error])
}
