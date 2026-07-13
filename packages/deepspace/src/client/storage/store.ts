/**
 * RecordStore
 *
 * Manages query subscriptions with version-tracked caching.
 * Uses external store pattern for React integration.
 */

import type { RecordData } from './types'

/**
 * Immutable snapshot handed to `useSyncExternalStore`. A new object is minted
 * on every state transition (see `commit`), so a change to `status`/`error` —
 * not just `records` — flips the snapshot reference and re-renders the hook.
 * Without `status`/`error` in the snapshot, an error that arrives before the
 * first result (records reference unchanged) never propagates and the UI is
 * stuck in "loading" forever.
 */
export interface QuerySnapshot {
  status: 'loading' | 'ready' | 'error'
  records: RecordData[]
  error?: string
}

interface QueryState {
  version: number // Incremented on every change
  snapshot: QuerySnapshot // Stable reference until any field changes
}

// Stable empty array - never changes reference
const EMPTY_RECORDS: RecordData[] = []
// Stable snapshot for queries that don't exist yet.
const EMPTY_SNAPSHOT: QuerySnapshot = { status: 'loading', records: EMPTY_RECORDS }

export class RecordStore {
  private queries = new Map<string, QueryState>()
  private listeners = new Map<string, Set<() => void>>()
  /** Reference count for each query - only send SUBSCRIBE on first, UNSUBSCRIBE on last */
  private refCounts = new Map<string, number>()
  /** Track the single subscriptionId per queryKey (for deduplication) */
  private activeSubscriptions = new Map<string, string>()

  subscribe(queryKey: string, listener: () => void): () => void {
    const set = this.listeners.get(queryKey) ?? new Set()
    set.add(listener)
    this.listeners.set(queryKey, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) {
        this.listeners.delete(queryKey)
      }
    }
  }

  /**
   * Snapshot for `useSyncExternalStore`. Bundles records + status + error so a
   * transition in any of them re-renders the hook. Returns a stable reference
   * until the next `commit()`.
   */
  getSnapshot(queryKey: string): QuerySnapshot {
    return this.queries.get(queryKey)?.snapshot ?? EMPTY_SNAPSHOT
  }

  /**
   * Initialize a query subscription.
   * Returns true if this is the FIRST subscriber (should send SUBSCRIBE).
   */
  initQuery(queryKey: string): boolean {
    const prevCount = this.refCounts.get(queryKey) ?? 0
    this.refCounts.set(queryKey, prevCount + 1)

    if (!this.queries.has(queryKey)) {
      this.queries.set(queryKey, {
        version: 0,
        snapshot: { status: 'loading', records: EMPTY_RECORDS },
      })
    }

    // Return true if this is the first subscriber
    return prevCount === 0
  }

  /**
   * Release a query subscription.
   * Returns true if this was the LAST subscriber (should send UNSUBSCRIBE).
   */
  releaseQuery(queryKey: string): boolean {
    const count = (this.refCounts.get(queryKey) ?? 1) - 1

    if (count <= 0) {
      this.refCounts.delete(queryKey)
      this.activeSubscriptions.delete(queryKey)
      return true // Last subscriber
    }

    this.refCounts.set(queryKey, count)
    return false // Still has subscribers
  }

  /** Store the subscriptionId for a queryKey (for routing server responses) */
  setSubscriptionId(queryKey: string, subscriptionId: string): void {
    this.activeSubscriptions.set(queryKey, subscriptionId)
  }

  /** Get the subscriptionId for a queryKey */
  getSubscriptionId(queryKey: string): string | undefined {
    return this.activeSubscriptions.get(queryKey)
  }

  /**
   * Replace the state for a query with a fresh snapshot and bump the version,
   * then notify listeners. Single write-path so every mutator mints a new
   * snapshot reference (which is what drives `useSyncExternalStore` re-renders).
   */
  private commit(queryKey: string, snapshot: QuerySnapshot): void {
    const version = (this.queries.get(queryKey)?.version ?? 0) + 1
    this.queries.set(queryKey, { version, snapshot })
    this.notify(queryKey)
  }

  // Handle QUERY_RESULT from server
  setQueryResult(queryKey: string, records: RecordData[]): void {
    this.commit(queryKey, { status: 'ready', records })
  }

  /** Check if a record exists in a query's results */
  hasRecord(queryKey: string, recordId: string): boolean {
    const state = this.queries.get(queryKey)
    if (!state) return false
    return state.snapshot.records.some((r) => r.recordId === recordId)
  }

  // Handle RECORD_CHANGE from server
  applyChange(
    queryKey: string,
    record: RecordData,
    changeType: 'create' | 'update' | 'delete',
  ): void {
    const state = this.queries.get(queryKey)
    if (!state) return
    const records = state.snapshot.records

    let newRecords: RecordData[]

    if (changeType === 'delete') {
      newRecords = records.filter((r) => r.recordId !== record.recordId)
    } else if (changeType === 'create') {
      // Check if record already exists (prevent duplicates from race conditions)
      const exists = records.some((r) => r.recordId === record.recordId)
      if (exists) {
        // If it exists, treat as update instead
        newRecords = records.map((r) => (r.recordId === record.recordId ? record : r))
      } else {
        // Append (correct for asc order, which is the common case for real-time data)
        newRecords = [...records, record]
      }
    } else {
      // update
      newRecords = records.map((r) => (r.recordId === record.recordId ? record : r))
    }

    // Carry the existing status AND error through: a RECORD_CHANGE can arrive
    // while a query is in `status: 'error'`, and dropping `error` here would
    // leave consumers reading an error state with no message.
    this.commit(queryKey, {
      status: state.snapshot.status,
      records: newRecords,
      error: state.snapshot.error,
    })
  }

  /**
   * Reset a query to loading state (used on WebSocket reconnect).
   * Preserves stale records so the UI can show them while reconnecting.
   */
  resetToLoading(queryKey: string): void {
    const current = this.queries.get(queryKey)
    if (!current) return
    this.commit(queryKey, { status: 'loading', records: current.snapshot.records })
  }

  setError(queryKey: string, error: string): void {
    const records = this.queries.get(queryKey)?.snapshot.records ?? EMPTY_RECORDS
    this.commit(queryKey, { status: 'error', records, error })
  }

  // Cleanup when query is no longer needed
  removeQuery(queryKey: string): void {
    this.queries.delete(queryKey)
    this.listeners.delete(queryKey)
  }

  private notify(queryKey: string): void {
    const set = this.listeners.get(queryKey)
    if (set) {
      set.forEach((fn) => fn())
    }
  }
}
