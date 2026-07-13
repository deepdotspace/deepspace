import type { RecordData } from './types'

/**
 * Client-side mirror of the server's where-builder (executeTableQuery):
 * schema columns take precedence over envelope fields so initial load and
 * live updates agree when a schema defines a column named 'createdBy'.
 * ONE copy — context.tsx and RecordScope.tsx both filter live changes
 * through this; a divergence shows up as records flickering in one provider
 * and not the other.
 */
export function recordMatchesWhere(
  record: RecordData,
  where?: Record<string, unknown>,
): boolean {
  if (!where) return true
  const r = record as RecordData & { data?: Record<string, unknown> }
  const data = r.data
  if (!data) return false
  return Object.entries(where).every(([key, value]) => {
    if (key in data) return data[key] === value
    if (key === 'recordId') return r.recordId === value
    if (key === 'createdBy') return r.createdBy === value
    return false
  })
}

/** Shared reconnect backoff: 1s doubling to a 30s ceiling. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 30000)
}
