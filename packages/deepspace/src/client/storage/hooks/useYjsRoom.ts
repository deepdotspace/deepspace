/**
 * useYjsRoom — Connect to a dedicated YjsRoom Durable Object.
 *
 * Unlike useYjsField (which piggybacks on RecordRoom's WebSocket),
 * this hook opens a direct WebSocket to a YjsRoom DO at /ws/yjs/:docId.
 * Each document gets its own DO for horizontal scaling.
 *
 * Uses the shared yjs-protocol.ts encoding — no duplication.
 *
 * @example
 * const { doc, text, setText, synced, canWrite } = useYjsRoom(docId, 'content')
 */

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react'
import * as Y from 'yjs'
import { getAuthToken } from '../../auth'
import { wsLog } from '../ws-log'
import {
  MSG_AWARENESS,
  MSG_SYNC,
  MSG_SYNC_STEP1,
  MSG_SYNC_STEP2,
  MSG_SYNC_UPDATE,
  Awareness,
  createEncoder,
  createDecoder,
  toUint8Array,
  encodeAwarenessMessage,
  handleAwarenessMessage,
  writeVarUint,
  writeVarUint8Array,
  readVarUint,
  readVarUint8Array,
} from '@/shared/protocol/yjs'

const UPDATE_BATCH_DELAY_MS = 16

// ============================================================================
// Hook
// ============================================================================

export interface UseYjsRoomResult {
  /** The Yjs document */
  doc: Y.Doc
  /** Awareness instance for presence/typing state */
  awareness: Awareness
  /** Current text content (for the specified field) */
  text: string
  /** Set text (replaces full content) */
  setText: (value: string) => void
  /** Whether initial sync is complete */
  synced: boolean
  /** Whether user has write access */
  canWrite: boolean
  /** Whether the server has resolved this connection's write permission */
  writeAuthResolved: boolean
}

/**
 * Connect to a YjsRoom DO for collaborative editing.
 *
 * @param docId - Document identifier (maps to DO name)
 * @param fieldName - Y.Text field name within the Y.Doc
 */
export function useYjsRoom(docId: string, fieldName: string): UseYjsRoomResult {
  const [syncedDocId, setSyncedDocId] = useState<string | null>(null)
  const [canWrite, setCanWrite] = useState(false)
  const [writeAuthResolved, setWriteAuthResolved] = useState(false)
  const [text, setTextState] = useState('')
  const [, setUpdateCount] = useState(0)
  const synced = syncedDocId === docId

  const { doc, awareness } = useMemo(() => {
    const nextDoc = new Y.Doc()
    return { doc: nextDoc, awareness: new Awareness(nextDoc) }
    // docId deliberately owns this resource pair. Reusing either resource
    // across room ids can answer B's sync handshake with A's document state.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- docId is the Yjs document identity
  }, [docId])

  const wsRef = useRef<WebSocket | null>(null)
  const isLocalRef = useRef(false)
  const applyingRemoteAwarenessRef = useRef(false)
  const pendingUpdateRef = useRef<Uint8Array | null>(null)
  const updateBatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const yText = useMemo(() => doc.getText(fieldName), [doc, fieldName])

  const flushPendingUpdate = useCallback((socket = wsRef.current) => {
    if (updateBatchTimerRef.current) clearTimeout(updateBatchTimerRef.current)
    updateBatchTimerRef.current = null
    const update = pendingUpdateRef.current
    pendingUpdateRef.current = null
    if (!update || !socket || socket.readyState !== WebSocket.OPEN) return

    const enc = createEncoder()
    writeVarUint(enc, MSG_SYNC)
    writeVarUint(enc, MSG_SYNC_UPDATE)
    writeVarUint8Array(enc, update)
    socket.send(toUint8Array(enc).buffer)
  }, [])

  useEffect(() => {
    return () => {
      awareness.destroy()
      doc.destroy()
    }
  }, [awareness, doc])

  useLayoutEffect(() => {
    setSyncedDocId(null)
    setCanWrite(false)
    setWriteAuthResolved(false)
    setTextState('')
  }, [docId])

  // Observe remote Y.Text changes
  useEffect(() => {
    const observer = () => {
      if (isLocalRef.current) return
      setTextState(yText.toString())
    }
    yText.observe(observer)
    return () => yText.unobserve(observer)
  }, [yText])

  // WebSocket connection to YjsRoom DO
  useEffect(() => {
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let alive = true

    const renewLocalAwareness = () => {
      const localState = awareness.getLocalState()
      if (localState) awareness.setLocalState(localState)
    }

    const connect = async () => {
      if (!alive) return

      // Permissions belong to one socket handshake. Every replacement socket
      // starts closed, including reconnects and same-room field changes.
      setCanWrite(false)
      setWriteAuthResolved(false)

      // The server's disconnect tombstone advances the old awareness clock
      // once. Renew while offline and again on open so the one transmitted
      // replay is strictly newer and peers accept it immediately.
      renewLocalAwareness()

      const token = await getAuthToken()
      // Unmounted (or reconnect superseded) while awaiting the token — bail so
      // we don't open a socket the cleanup can no longer reach and close.
      if (!alive) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const baseUrl = `${protocol}//${window.location.host}`
      const url = new URL(`/ws/yjs/${encodeURIComponent(docId)}`, baseUrl)
      if (token) url.searchParams.set('token', token)

      wsLog('connecting', `yjs:${docId}`)
      ws = new WebSocket(url.toString())
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ws.onopen = () => {
        wsLog('connected', `yjs:${docId}`)
        setSyncedDocId(null)
        renewLocalAwareness()
      }

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data) as { type?: string; canWrite?: unknown }
            if (msg.type === 'auth' && typeof msg.canWrite === 'boolean') {
              setCanWrite(msg.canWrite)
              setWriteAuthResolved(true)
            }
          } catch {
            /* ignore */
          }
          return
        }

        const data = new Uint8Array(event.data as ArrayBuffer)
        const decoder = createDecoder(data)
        const messageType = readVarUint(decoder)

        if (messageType === MSG_SYNC) {
          const syncType = readVarUint(decoder)
          const payload = readVarUint8Array(decoder)

          switch (syncType) {
            case MSG_SYNC_STEP1: {
              const diff = Y.encodeStateAsUpdate(doc, payload)
              const enc = createEncoder()
              writeVarUint(enc, MSG_SYNC)
              writeVarUint(enc, MSG_SYNC_STEP2)
              writeVarUint8Array(enc, diff)
              ws?.send(toUint8Array(enc).buffer)
              setSyncedDocId(docId)
              break
            }
            case MSG_SYNC_STEP2: {
              Y.applyUpdate(doc, payload, 'server')
              setTextState(yText.toString())
              setSyncedDocId(docId)
              break
            }
            case MSG_SYNC_UPDATE: {
              Y.applyUpdate(doc, payload, 'server')
              setUpdateCount((c) => c + 1)
              break
            }
          }
          return
        }

        if (messageType === MSG_AWARENESS) {
          applyingRemoteAwarenessRef.current = true
          try {
            handleAwarenessMessage(awareness, data)
          } catch {
            // Awareness is ephemeral. Ignore a malformed peer frame without
            // breaking subsequent document sync messages on this socket.
          } finally {
            applyingRemoteAwarenessRef.current = false
          }
        }
      }

      ws.onclose = () => {
        wsLog('disconnected', `yjs:${docId}`)
        wsRef.current = null
        setSyncedDocId(null)
        setCanWrite(false)
        setWriteAuthResolved(false)
        if (alive) reconnectTimer = setTimeout(connect, 1000)
      }

      ws.onerror = () => ws?.close()
    }

    connect()

    return () => {
      wsLog('closing', `yjs:${docId}`)
      alive = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      // This effect owns the socket, so it must drain a pending local batch
      // before closing it. A later effect cleanup cannot safely do so.
      flushPendingUpdate(ws)
      if (ws) {
        ws.onclose = null
        ws.onmessage = null
        ws.onerror = null
        ws.close()
      }
      wsRef.current = null
    }
  }, [doc, awareness, docId, flushPendingUpdate, yText])

  // Relay local awareness updates (presence, typing) through YjsRoom with shared MSG_AWARENESS encoding.
  useEffect(() => {
    const handler = ({
      added,
      updated,
      removed,
    }: {
      added: number[]
      updated: number[]
      removed: number[]
    }) => {
      if (applyingRemoteAwarenessRef.current) return
      const changedClients = added.concat(updated).concat(removed)
      if (changedClients.length === 0) return

      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return

      ws.send(encodeAwarenessMessage(awareness, changedClients).buffer)
    }

    awareness.on('update', handler)
    return () => {
      awareness.off('update', handler)
      awareness.setLocalState(null)
    }
  }, [awareness])

  // Send local Y.Doc updates to server
  useEffect(() => {
    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin === 'server') return
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return

      pendingUpdateRef.current = pendingUpdateRef.current
        ? Y.mergeUpdates([pendingUpdateRef.current, update])
        : update
      updateBatchTimerRef.current ??= setTimeout(flushPendingUpdate, UPDATE_BATCH_DELAY_MS)
    }

    doc.on('update', handler)
    return () => {
      doc.off('update', handler)
      flushPendingUpdate()
    }
  }, [doc, flushPendingUpdate])

  // setText: update Y.Text + local state
  const setText = useCallback(
    (value: string) => {
      setTextState(value)
      if (!canWrite) return

      isLocalRef.current = true
      doc.transact(() => {
        yText.delete(0, yText.length)
        yText.insert(0, value)
      })
      isLocalRef.current = false
    },
    [doc, yText, canWrite],
  )

  return { doc, awareness, text, setText, synced, canWrite, writeAuthResolved }
}
