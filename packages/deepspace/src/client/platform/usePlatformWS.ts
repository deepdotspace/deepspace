/**
 * usePlatformWS — Generic WebSocket hook for platform DO connections.
 *
 * Handles all the boilerplate:
 *  - Auth token fetch
 *  - WebSocket connection with wss:// protocol detection
 *  - Exponential backoff reconnect (500ms -> 10s max)
 *  - Ping every 30s
 *  - Cleanup on unmount or scopeId change
 *
 * Usage:
 *   const state = usePlatformWS({
 *     path: 'orders',          // -> /platform/ws/orders/{scopeId}
 *     scopeId: 'app:demo-corp',
 *     initialState: { orders: [], items: {}, status: 'connecting' },
 *     onMessage: (msg, prev) => {
 *       switch (msg.type) {
 *         case 'init': return { orders: msg.orders, items: msg.items, status: 'connected' }
 *         case 'order_created': return { ...prev, orders: [...prev.orders, msg.order] }
 *         default: return prev
 *       }
 *     },
 *   })
 */

import { useState, useEffect, useRef } from 'react'
import { getAuthToken } from '../auth/token'
import type { ConnectionStatus } from '../storage/connection-status'

const MAX_RECONNECT_DELAY = 10_000
const BASE_RECONNECT_DELAY = 500

export interface PlatformWSOptions<S> {
  /** DO path segment — e.g. 'orders' for /platform/ws/orders/{scopeId} */
  path: string
  /** Scope ID — e.g. 'app:demo-corp'. Passing undefined skips connection. */
  scopeId: string | undefined
  /** Initial state before WS connects */
  initialState: S
  /**
   * Message handler. Receives the parsed message and current state.
   * Return a new state to update, or the same `prev` reference to skip.
   * The 'init' message should reset reconnect (handled automatically)
   * and return state with status: 'connected'.
   */
  onMessage: (msg: Record<string, unknown>, prev: S) => S
}

export interface PlatformWSResult<S> {
  state: S
  /** Send a JSON message to the WebSocket */
  send: (msg: Record<string, unknown>) => void
}

export function usePlatformWS<S extends { status: ConnectionStatus }>(
  options: PlatformWSOptions<S>,
): PlatformWSResult<S> {
  const { path, scopeId, initialState, onMessage } = options
  const wsRef = useRef<WebSocket | null>(null)
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [state, setState] = useState<S>(initialState)
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  // Keep onMessage ref stable to avoid reconnecting when handler identity changes
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  const initialStateRef = useRef(initialState)
  initialStateRef.current = initialState

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (!scopeId) return

    setState(initialStateRef.current)
    reconnectAttemptRef.current = 0

    async function connect() {
      if (!mountedRef.current || !scopeId) return

      const token = await getAuthToken()
      if (!token || !mountedRef.current) {
        reconnectTimerRef.current = setTimeout(connect, 2_000)
        return
      }

      const params = new URLSearchParams()
      params.set('token', token)

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(
        `${protocol}//${window.location.host}/platform/ws/${path}/${scopeId}?${params}`,
      )
      wsRef.current = ws

      ws.onmessage = (e) => {
        if (e.data === 'pong') return
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'init') {
            reconnectAttemptRef.current = 0
          }
          setState(prev => onMessageRef.current(msg, prev))
        } catch (err) {
          console.error(`[usePlatformWS:${path}] message parse error:`, err)
        }
      }

      ws.onclose = () => {
        if (!mountedRef.current) return
        const attempt = reconnectAttemptRef.current++
        const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, attempt), MAX_RECONNECT_DELAY)
        setState(prev => ({
          ...prev,
          status: (attempt === 0 ? 'connecting' : 'reconnecting') as ConnectionStatus,
        }))
        reconnectTimerRef.current = setTimeout(connect, delay)
      }

      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current)
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping')
      }, 30_000)
    }

    connect()

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current)
        pingIntervalRef.current = null
      }
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [scopeId, path])

  const send = useRef((msg: Record<string, unknown>) => {
    wsRef.current?.send(JSON.stringify(msg))
  }).current

  return { state, send }
}
