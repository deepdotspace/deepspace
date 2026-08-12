/**
 * usePresenceRoom — Connect to a PresenceRoom Durable Object.
 *
 * Opens a WebSocket to /ws/presence/:scopeId for real-time presence tracking.
 * Use with any scope: canvas, doc, thread, page, etc.
 *
 * Peers can share small ephemeral state (cursor position, typing indicator,
 * viewport, selection) via updateState().
 *
 * @example
 * // Track who's on a canvas
 * const { peers, connected, updateState } = usePresenceRoom(`canvas:${canvasId}`)
 *
 * // Share cursor position
 * updateState({ cursor: { x: 100, y: 200 } })
 *
 * // Track who's viewing a thread
 * const { peers } = usePresenceRoom(`thread:${channelId}`)
 *
 * // Show typing indicator
 * updateState({ typing: true })
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { getAuthToken } from '../../auth'
import { useRecordAuth } from '../context'
import { wsLog } from '../ws-log'
import { MSG } from '@/shared/protocol/constants'
import { clientBuild, dispatch, encode, type ServerMessage } from '@/shared/protocol/messages'

// ============================================================================
// Types
// ============================================================================

export interface PresencePeerClient {
  userId: string
  userName: string
  joinedAt: string
  state: Record<string, unknown>
}

export interface UsePresenceRoomResult {
  /** All peers currently present in this scope (excludes self) */
  peers: PresencePeerClient[]
  /** Whether the WebSocket is connected */
  connected: boolean
  /** Send a state update (cursor, typing, viewport, etc.) — merges with existing state */
  updateState: (state: Record<string, unknown>) => void
}

// ============================================================================
// Hook
// ============================================================================

export function usePresenceRoom(scopeId: string): UsePresenceRoomResult {
  const auth = useRecordAuth()
  const tokenProvider = auth?.getAuthToken ?? getAuthToken
  const [peers, setPeers] = useState<PresencePeerClient[]>([])
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    setConnected(false)
    setPeers([])
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let alive = true
    let browserOnline = typeof navigator === 'undefined' || navigator.onLine
    let connecting = false

    const connect = async () => {
      if (!alive || !browserOnline || connecting) return
      if (ws?.readyState === WebSocket.CONNECTING || ws?.readyState === WebSocket.OPEN) return
      connecting = true

      let token: string | null
      try {
        token = await tokenProvider()
      } finally {
        connecting = false
      }
      if (!alive || !browserOnline) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const baseUrl = `${protocol}//${window.location.host}`
      const url = new URL(`/ws/presence/${encodeURIComponent(scopeId)}`, baseUrl)
      if (token) url.searchParams.set('token', token)

      wsLog('connecting', `presence:${scopeId}`)
      const socket = new WebSocket(url.toString())
      ws = socket
      wsRef.current = socket

      socket.onopen = () => {
        if (ws !== socket) return socket.close()
        wsLog('connected', `presence:${scopeId}`)
        setConnected(true)
      }

      socket.onmessage = (event) => {
        dispatch<ServerMessage>(event.data, {
          [MSG.PRESENCE_SYNC]: (p) => {
            setPeers(p.peers as PresencePeerClient[])
          },
          [MSG.PRESENCE_JOIN]: (p) => {
            const peer = p.peer as PresencePeerClient
            setPeers((prev) => [...prev.filter((x) => x.userId !== peer.userId), peer])
          },
          [MSG.PRESENCE_LEAVE]: (p) => {
            setPeers((prev) => prev.filter((x) => x.userId !== p.userId))
          },
          [MSG.PRESENCE_UPDATE]: (p) => {
            setPeers((prev) =>
              prev.map((x) =>
                x.userId === p.userId ? { ...x, state: { ...x.state, ...p.state } } : x,
              ),
            )
          },
        })
      }

      socket.onclose = () => {
        if (ws !== socket) return
        wsLog('disconnected', `presence:${scopeId}`)
        ws = null
        wsRef.current = null
        setConnected(false)
        if (alive && browserOnline) reconnectTimer = setTimeout(connect, 1000)
      }

      socket.onerror = () => socket.close()
    }

    const handleOffline = () => {
      browserOnline = false
      setConnected(false)
      ws?.close()
    }
    const handleOnline = () => {
      browserOnline = true
      void connect()
    }

    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)
    void connect()

    return () => {
      wsLog('closing', `presence:${scopeId}`)
      alive = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
      if (ws) {
        ws.onclose = null
        ws.onmessage = null
        ws.onerror = null
        ws.close()
      }
      wsRef.current = null
    }
  }, [scopeId, tokenProvider])

  const updateState = useCallback((state: Record<string, unknown>) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(encode(clientBuild.presenceUpdate(state)))
  }, [])

  return { peers, connected, updateState }
}
