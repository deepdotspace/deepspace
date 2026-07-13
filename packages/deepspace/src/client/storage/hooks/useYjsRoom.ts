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

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
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
}

/**
 * Connect to a YjsRoom DO for collaborative editing.
 *
 * @param docId - Document identifier (maps to DO name)
 * @param fieldName - Y.Text field name within the Y.Doc
 */
export function useYjsRoom(docId: string, fieldName: string): UseYjsRoomResult {
  const [synced, setSynced] = useState(false)
  const [canWrite, setCanWrite] = useState(false)
  const [text, setTextState] = useState('')
  const [, setUpdateCount] = useState(0)

  const docRef = useRef<Y.Doc | null>(null)
  if (!docRef.current) docRef.current = new Y.Doc()
  const doc = docRef.current

  const awarenessRef = useRef<Awareness | null>(null)
  if (!awarenessRef.current) awarenessRef.current = new Awareness(doc)
  const awareness = awarenessRef.current

  const wsRef = useRef<WebSocket | null>(null)
  const isLocalRef = useRef(false)
  const applyingRemoteAwarenessRef = useRef(false)

  const yText = useMemo(() => doc.getText(fieldName), [doc, fieldName])

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

    const connect = async () => {
      if (!alive) return

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
        setSynced(false)
      }

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data) as { type?: string; canWrite?: unknown }
            if (msg.type === 'auth' && typeof msg.canWrite === 'boolean') setCanWrite(msg.canWrite)
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
              setSynced(true)
              break
            }
            case MSG_SYNC_STEP2: {
              Y.applyUpdate(doc, payload, 'server')
              setTextState(yText.toString())
              setSynced(true)
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
          } finally {
            applyingRemoteAwarenessRef.current = false
          }
        }
      }

      ws.onclose = () => {
        wsLog('disconnected', `yjs:${docId}`)
        wsRef.current = null
        setSynced(false)
        if (alive) reconnectTimer = setTimeout(connect, 1000)
      }

      ws.onerror = () => ws?.close()
    }

    connect()

    return () => {
      wsLog('closing', `yjs:${docId}`)
      alive = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (ws) {
        ws.onclose = null
        ws.onmessage = null
        ws.onerror = null
        ws.close()
      }
      wsRef.current = null
    }
  }, [doc, awareness, docId, yText])

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

      const enc = createEncoder()
      writeVarUint(enc, MSG_SYNC)
      writeVarUint(enc, MSG_SYNC_UPDATE)
      writeVarUint8Array(enc, update)
      ws.send(toUint8Array(enc).buffer)
    }

    doc.on('update', handler)
    return () => {
      doc.off('update', handler)
    }
  }, [doc])

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

  return { doc, awareness, text, setText, synced, canWrite }
}
