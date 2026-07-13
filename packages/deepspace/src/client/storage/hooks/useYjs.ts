/**
 * Yjs Collaborative Editing Hooks
 *
 * Real-time collaborative editing using Yjs.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import * as Y from 'yjs'
import { useRecordContext } from '../context'
import { debugLog } from '../../debug'
import { MSG_YJS_SYNC, MSG_YJS_AWARENESS, MSG } from '@/shared/protocol/constants'
import {
  MSG_SYNC_STEP1,
  MSG_SYNC_STEP2,
  MSG_SYNC_UPDATE,
  Awareness,
  createEncoder,
  createDecoder,
  toUint8Array,
  writeVarUint,
  writeVarUint8Array,
  readVarUint,
  readVarUint8Array,
} from '@/shared/protocol/yjs'

// ============================================================================
// useYjsField
// ============================================================================

export interface UseYjsFieldResult {
  /** The Yjs document for this field */
  doc: Y.Doc
  /** Awareness instance for cursor/presence sync */
  awareness: Awareness
  /** Whether initial sync is complete */
  synced: boolean
  /** Whether user has write access */
  canWrite: boolean
  /** Force re-render counter (changes when doc updates) */
  updateCount: number
}

/**
 * Hook for collaborative editing of a Yjs field.
 *
 * @param collection - Collection name
 * @param recordId - Record ID
 * @param fieldName - Field name (must be type: 'yjs' in schema)
 *
 * @example
 * const { doc, synced, canWrite } = useYjsField('documents', docId, 'content')
 * const text = doc.getText('content')
 */
export function useYjsField(
  collection: string,
  recordId: string,
  fieldName: string,
): UseYjsFieldResult {
  const { sendMessage, sendBinary, onBinaryMessage, registerYjsJoinHandler, ready } =
    useRecordContext()
  const [synced, setSynced] = useState(false)
  const [canWrite, setCanWrite] = useState(false)
  const [updateCount, setUpdateCount] = useState(0)
  const canWriteRef = useRef(false)

  // Stable Yjs doc instance
  const docRef = useRef<Y.Doc | null>(null)
  if (!docRef.current) {
    docRef.current = new Y.Doc()
  }
  const doc = docRef.current

  // Stable awareness instance (one per doc)
  const awarenessRef = useRef<Awareness | null>(null)
  if (!awarenessRef.current) {
    awarenessRef.current = new Awareness(doc)
  }
  const awareness = awarenessRef.current

  const docKey = `${collection}:${recordId}:${fieldName}`

  // Keep ref in sync with state for use in callbacks
  useEffect(() => {
    canWriteRef.current = canWrite
  }, [canWrite])

  // Handle join response from server
  useEffect(() => {
    return registerYjsJoinHandler(docKey, setCanWrite)
  }, [docKey, registerYjsJoinHandler])

  // Handle incoming binary messages (sync + awareness)
  useEffect(() => {
    const handleBinaryMessage = (data: ArrayBuffer) => {
      const decoder = createDecoder(new Uint8Array(data))
      const messageType = readVarUint(decoder)

      // Handle awareness messages
      if (messageType === MSG_YJS_AWARENESS) {
        const msgDocKey = new TextDecoder().decode(readVarUint8Array(decoder))
        if (msgDocKey !== docKey) return
        const payload = readVarUint8Array(decoder)
        awareness.applyUpdate(payload)
        return
      }

      if (messageType !== MSG_YJS_SYNC) return

      const msgDocKey = new TextDecoder().decode(readVarUint8Array(decoder))
      if (msgDocKey !== docKey) return

      const syncType = readVarUint(decoder)
      const payload = readVarUint8Array(decoder)

      switch (syncType) {
        case MSG_SYNC_STEP1: {
          // Server sent state vector - respond with our diff
          const ourDiff = Y.encodeStateAsUpdate(doc, payload)
          const encoder = createEncoder()
          writeVarUint(encoder, MSG_YJS_SYNC)
          writeVarUint8Array(encoder, new TextEncoder().encode(docKey))
          writeVarUint(encoder, MSG_SYNC_STEP2)
          writeVarUint8Array(encoder, ourDiff)
          sendBinary(toUint8Array(encoder))
          setSynced(true)
          break
        }
        case MSG_SYNC_STEP2: {
          // Server sent full state diff
          Y.applyUpdate(doc, payload, 'server')
          setSynced(true)
          break
        }
        case MSG_SYNC_UPDATE: {
          // Server relayed update from another client
          Y.applyUpdate(doc, payload, 'server')
          break
        }
      }
    }

    return onBinaryMessage(handleBinaryMessage)
  }, [doc, awareness, docKey, sendBinary, onBinaryMessage])

  // Send local awareness changes to server
  useEffect(() => {
    if (!ready) return

    const handleAwarenessUpdate = ({
      added,
      updated,
      removed,
    }: {
      added: number[]
      updated: number[]
      removed: number[]
    }) => {
      const changedClients = added.concat(updated).concat(removed)
      if (changedClients.length === 0) return

      const encoder = createEncoder()
      writeVarUint(encoder, MSG_YJS_AWARENESS)
      writeVarUint8Array(encoder, new TextEncoder().encode(docKey))
      writeVarUint8Array(encoder, awareness.encodeUpdate(changedClients))
      sendBinary(toUint8Array(encoder))
    }

    awareness.on('update', handleAwarenessUpdate)
    return () => {
      awareness.off('update', handleAwarenessUpdate)
    }
  }, [awareness, docKey, sendBinary, ready])

  // Join channel when ready - re-join on reconnect
  useEffect(() => {
    if (!ready) {
      // Reset state when disconnected
      debugLog('[YJS] Not ready, resetting:', docKey)
      setSynced(false)
      setCanWrite(false)
      return
    }

    debugLog('[YJS] Joining:', docKey)
    sendMessage({ type: MSG.YJS_JOIN, payload: { collection, recordId, fieldName } })

    return () => {
      // Clear local awareness state before leaving
      awareness.setLocalState(null)
      debugLog('[YJS] Leaving:', docKey)
      sendMessage({ type: MSG.YJS_LEAVE, payload: { collection, recordId, fieldName } })
    }
  }, [ready, collection, recordId, fieldName, sendMessage, docKey, awareness])

  // Send local updates to server
  useEffect(() => {
    const handleUpdate = (update: Uint8Array, origin: unknown) => {
      setUpdateCount((c) => c + 1)

      // Only send local updates when we have write permission
      if (origin === 'server' || !canWriteRef.current) return

      const encoder = createEncoder()
      writeVarUint(encoder, MSG_YJS_SYNC)
      writeVarUint8Array(encoder, new TextEncoder().encode(docKey))
      writeVarUint(encoder, MSG_SYNC_UPDATE)
      writeVarUint8Array(encoder, update)
      sendBinary(toUint8Array(encoder))
    }

    doc.on('update', handleUpdate)
    return () => {
      doc.off('update', handleUpdate)
    }
  }, [doc, docKey, sendBinary])

  // synced is only true when WebSocket is connected AND initial sync is complete
  return { doc, awareness, synced: ready && synced, canWrite, updateCount }
}

// ============================================================================
// useYjsText
// ============================================================================

export interface UseYjsTextResult {
  /** Current text content */
  text: string
  /** Set text content (replaces entire content) */
  setText: (value: string) => void
  /** Whether initial sync is complete */
  synced: boolean
  /** Whether user has write access */
  canWrite: boolean
}

/**
 * Simplified hook for collaborative text editing.
 *
 * Provides a string-based API instead of raw Yjs doc access.
 * Perfect for textarea/input fields.
 *
 * @param collection - Collection name
 * @param recordId - Record ID
 * @param fieldName - Field name (must be type: 'yjs' in schema)
 *
 * @example
 * const { text, setText, synced, canWrite } = useYjsText('documents', docId, 'content')
 *
 * <textarea
 *   value={text}
 *   onChange={(e) => setText(e.target.value)}
 *   disabled={!synced || !canWrite}
 * />
 */
export function useYjsText(
  collection: string,
  recordId: string,
  fieldName: string,
): UseYjsTextResult {
  const { doc, synced, canWrite, updateCount } = useYjsField(collection, recordId, fieldName)
  const [text, setTextState] = useState('')
  const yTextRef = useRef<Y.Text | null>(null)
  const isLocalUpdateRef = useRef(false)

  // Get Y.Text instance once doc is ready
  useEffect(() => {
    yTextRef.current = doc.getText(fieldName)
  }, [doc, fieldName])

  // Sync Y.Text to local state when doc updates
  useEffect(() => {
    if (yTextRef.current && synced && !isLocalUpdateRef.current) {
      setTextState(yTextRef.current.toString())
    }
    isLocalUpdateRef.current = false
  }, [synced, updateCount])

  // setText function that updates both local state and Yjs
  const setText = useCallback(
    (value: string) => {
      setTextState(value)

      if (yTextRef.current && canWrite) {
        isLocalUpdateRef.current = true
        doc.transact(() => {
          const yText = yTextRef.current!
          yText.delete(0, yText.length)
          yText.insert(0, value)
        })
      }
    },
    [doc, canWrite],
  )

  return { text, setText, synced, canWrite }
}
