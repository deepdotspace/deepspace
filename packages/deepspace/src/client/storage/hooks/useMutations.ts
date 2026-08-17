/**
 * useMutations Hook
 *
 * Get mutation functions for a collection.
 * Resolves the correct scope via ScopeRegistry (multi-scope)
 * or uses the nearest RecordScope context during registry transitions.
 */

import { useCallback, useContext, useMemo } from 'react'
import { RecordContext, useRecordAuth } from '../context'
import { useScopeRegistry } from '../ScopeRegistry'
import { RecordRoomNotReadyError } from '../errors'
import { MSG } from '@/shared/protocol/constants'

/**
 * Get mutation functions for a collection.
 *
 * Type contract:
 *   - `create(data)` requires the **full** record shape `T`. New records
 *     have no existing data to merge with, so all fields the schema
 *     considers required must be present.
 *   - `put(recordId, patch)` accepts a **`Partial<T>`**. The server
 *     merges the patch into the existing row (`{...existing, ...patch}`),
 *     so callers should send only the fields they want to change.
 *
 * @example
 * ```tsx
 * const { create, put, remove } = useMutations<Task>('tasks')
 *
 * // create needs the full Task shape
 * const id = await create({ title: 'New task', completed: false, priority: 1 })
 *
 * // put is a partial update — only the fields you want to change
 * await put(id, { completed: true })
 * await remove(id)
 * ```
 */
export function useMutations<T = unknown>(collection: string): {
  /** True once the collection's RecordRoom can accept writes. Disable the
   *  control on it (`disabled={!ready}`) rather than early-returning from
   *  the handler: an early return drops the user's write silently, while a
   *  write attempted before `ready` at least raises a `not_ready` error. */
  ready: boolean
  create: (data: T) => Promise<string>
  put: (recordId: string, data: Partial<T>) => Promise<void>
  remove: (recordId: string) => Promise<void>
  createConfirmed: (data: T) => Promise<string>
  putConfirmed: (recordId: string, data: Partial<T>) => Promise<void>
  removeConfirmed: (recordId: string) => Promise<void>
} {
  // Resolve through the registry and retain the nearest scope during navigation.
  const registry = useScopeRegistry()
  const recordCtx = useContext(RecordContext)
  // Stable wrapper from RecordProvider — safe in a dependency array.
  const onWriteError = useRecordAuth()?.onWriteError

  const scopeEntry = registry?.resolve(collection) ?? null

  // Prefer RecordContext when this scope handles the collection (avoids stale ScopeRegistry during navigation)
  const preferLocal = recordCtx?.registeredCollections?.has(collection) ?? false
  const sendMessage = preferLocal ? recordCtx!.sendMessage : (scopeEntry?.sendMessage ?? recordCtx?.sendMessage)
  const sendConfirmed = preferLocal ? recordCtx!.sendConfirmed : (scopeEntry?.sendConfirmed ?? recordCtx?.sendConfirmed)
  const ready = preferLocal ? recordCtx!.ready : (scopeEntry?.ready ?? recordCtx?.ready ?? false)

  if (!sendMessage || !sendConfirmed) {
    throw new Error(
      `useMutations('${collection}'): No scope found. Wrap this hook in a RecordScope that registers the collection.`,
    )
  }

  // The single readiness gate for every mutation below. A write refused here
  // never touches the socket, so `onWriteError` — the one surface an app can
  // observe a rejected optimistic write on — is the only place it can show
  // up; it reports *and* throws, so callers that await keep their contract
  // and callers that don't still get a visible failure instead of silence.
  const assertReady = useCallback(() => {
    if (ready) return
    onWriteError?.({
      kind: 'not_ready',
      title: 'Not saved — still connecting',
      detail:
        `The room backing "${collection}" was not ready to accept writes yet, so the change was dropped. ` +
        `Gate the action on the \`ready\` flag from useMutations('${collection}') (e.g. \`disabled={!ready}\`) and retry once it is true.`,
    })
    throw new RecordRoomNotReadyError(collection)
  }, [ready, collection, onWriteError])

  const create = useCallback(
    async (data: T): Promise<string> => {
      assertReady()
      const recordId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
      sendMessage({ type: MSG.PUT, payload: { collection, recordId, data } })
      return recordId
    },
    [assertReady, sendMessage, collection],
  )

  const put = useCallback(
    async (recordId: string, data: Partial<T>): Promise<void> => {
      assertReady()
      sendMessage({ type: MSG.PUT, payload: { collection, recordId, data } })
    },
    [assertReady, sendMessage, collection],
  )

  const remove = useCallback(
    async (recordId: string): Promise<void> => {
      assertReady()
      sendMessage({ type: MSG.DELETE, payload: { collection, recordId } })
    },
    [assertReady, sendMessage, collection],
  )

  const createConfirmed = useCallback(
    async (data: T): Promise<string> => {
      assertReady()
      const recordId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
      await sendConfirmed({
        type: MSG.PUT,
        payload: { collection, recordId, data: data as Record<string, unknown> },
      })
      return recordId
    },
    [assertReady, sendConfirmed, collection],
  )

  const putConfirmed = useCallback(
    async (recordId: string, data: Partial<T>): Promise<void> => {
      assertReady()
      await sendConfirmed({
        type: MSG.PUT,
        payload: { collection, recordId, data: data as Record<string, unknown> },
      })
    },
    [assertReady, sendConfirmed, collection],
  )

  const removeConfirmed = useCallback(
    async (recordId: string): Promise<void> => {
      assertReady()
      await sendConfirmed({ type: MSG.DELETE, payload: { collection, recordId } })
    },
    [assertReady, sendConfirmed, collection],
  )

  // Memoize the return object so consumers get a stable reference.
  // Without this, every render produces a new object, which breaks any
  // useCallback/useEffect that depends on the useMutations() result
  // (e.g., cleanup effects re-fire and delete records they shouldn't).
  return useMemo(
    () => ({ ready, create, put, remove, createConfirmed, putConfirmed, removeConfirmed }),
    [ready, create, put, remove, createConfirmed, putConfirmed, removeConfirmed],
  )
}
