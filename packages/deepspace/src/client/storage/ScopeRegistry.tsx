/**
 * ScopeRegistry
 *
 * React context that maps collection names to scope entries.
 * RecordScope registers its collections on mount, and hooks
 * (useQuery, useMutations) resolve the correct scope by collection name.
 *
 * Each registration is tagged with a scopeId so that unregister only
 * removes entries owned by the calling scope — preventing one scope
 * from breaking another when both register the same collections.
 */

import { createContext, useContext, useCallback, useRef, useMemo, type ReactNode } from 'react'
import type { RecordStore } from './store'
import type { RoomConnectionState } from './types'

// ============================================================================
// Types
// ============================================================================

export interface ScopeEntry {
  store: RecordStore
  sendMessage: (msg: { type: string; payload: unknown }) => void
  sendConfirmed: (
    msg: { type: string; payload: Record<string, unknown> },
    timeoutMs?: number,
  ) => Promise<unknown>
  registerSubscription: (subscriptionId: string, queryKey: string) => void
  unregisterSubscription: (subscriptionId: string) => void
  sendBinary: (data: Uint8Array) => void
  onBinaryMessage: (handler: (data: ArrayBuffer) => void) => () => void
  registerYjsJoinHandler: (
    docKey: string,
    handler: (canWrite: boolean) => void,
  ) => () => void
  ready: boolean
  status: RoomConnectionState
}

interface Registration {
  scopeId: string
  entry: ScopeEntry
}

interface ScopeRegistryValue {
  register: (scopeId: string, collections: string[], entry: ScopeEntry) => void
  unregister: (scopeId: string, collections: string[]) => void
  resolve: (collection: string) => ScopeEntry | null
}

// ============================================================================
// Context
// ============================================================================

const ScopeRegistryContext = createContext<ScopeRegistryValue | null>(null)

export function useScopeRegistry(): ScopeRegistryValue | null {
  return useContext(ScopeRegistryContext)
}

// ============================================================================
// Provider
// ============================================================================

export function ScopeRegistryProvider({ children }: { children: ReactNode }) {
  const mapRef = useRef(new Map<string, Registration>())

  const register = useCallback((scopeId: string, collections: string[], entry: ScopeEntry) => {
    for (const name of collections) {
      mapRef.current.set(name, { scopeId, entry })
    }
  }, [])

  const unregister = useCallback((scopeId: string, collections: string[]) => {
    for (const name of collections) {
      const existing = mapRef.current.get(name)
      // Only unregister if this scope owns the registration
      if (existing?.scopeId === scopeId) {
        mapRef.current.delete(name)
      }
    }
  }, [])

  const resolve = useCallback((collection: string): ScopeEntry | null => {
    return mapRef.current.get(collection)?.entry ?? null
  }, [])

  const value = useMemo(() => ({ register, unregister, resolve }), [register, unregister, resolve])

  return (
    <ScopeRegistryContext.Provider value={value}>
      {children}
    </ScopeRegistryContext.Provider>
  )
}
