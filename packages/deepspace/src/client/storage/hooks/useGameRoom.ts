/**
 * useGameRoom — Connect to a GameRoom Durable Object.
 *
 * Opens a WebSocket to /ws/game/:roomId for real-time game state.
 *
 * @example
 * const { state, sendInput, players, connected } = useGameRoom('my-game')
 *
 * Implementation note: this hook uses the typed wire protocol helpers
 * (`clientBuild` for sends, `dispatch` for receives) from
 * `shared/protocol/messages`. Hand-rolled `switch (msg.type)` blocks and
 * raw `JSON.stringify({ type: MSG.X, payload: ... })` sends are a fast
 * route to the "silent drop" bug class when a payload shape drifts —
 * prefer the typed helpers instead.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { getAuthToken } from '../../auth'
import { wsLog } from '../ws-log'
import { MSG } from '@/shared/protocol/constants'
import {
  clientBuild,
  dispatch,
  encode,
  type ServerMessage,
} from '@/shared/protocol/messages'

export interface GamePlayer {
  userId: string
  userName: string
  ready: boolean
  connectedAt: string
  data: Record<string, unknown>
}

export interface UseGameRoomResult {
  /** Current game state */
  state: Record<string, unknown>
  /** Current tick number */
  tick: number
  /** Connected players */
  players: GamePlayer[]
  /** Whether the game is currently running */
  running: boolean
  /** Whether WebSocket is connected */
  connected: boolean
  /**
   * Whether this connection has write access. False for viewers /
   * unauthenticated spectators — they receive state broadcasts but the
   * send callbacks below no-op. UIs should disable input controls when
   * false so spectators see why their actions don't take effect.
   */
  canWrite: boolean
  /** Send a game input (no-op for spectators) */
  sendInput: (action: string, data?: Record<string, unknown>) => void
  /** Mark self as ready (no-op for spectators) */
  setReady: () => void
  /** Request game start (no-op for spectators) */
  startGame: () => void
  /** Request game end (no-op for spectators) */
  endGame: () => void
}

export function useGameRoom(roomId: string): UseGameRoomResult {
  const [gameState, setGameState] = useState<Record<string, unknown>>({})
  const [tick, setTick] = useState(0)
  const [players, setPlayers] = useState<GamePlayer[]>([])
  const [running, setRunning] = useState(false)
  const [connected, setConnected] = useState(false)
  // Default false: assume spectator until the server's AUTH frame
  // confirms otherwise. See GameRoom.onConnect.
  const [canWrite, setCanWrite] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let alive = true

    const connect = async () => {
      if (!alive) return

      const token = await getAuthToken()
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const baseUrl = `${protocol}//${window.location.host}`
      const url = new URL(`/ws/game/${encodeURIComponent(roomId)}`, baseUrl)
      if (token) url.searchParams.set('token', token)

      wsLog('connecting', `game:${roomId}`)
      ws = new WebSocket(url.toString())
      wsRef.current = ws

      ws.onopen = () => {
        wsLog('connected', `game:${roomId}`)
        setConnected(true)
      }

      ws.onmessage = (event) => {
        dispatch<ServerMessage>(event.data, {
          [MSG.AUTH]: (p) => {
            setCanWrite(p.canWrite)
          },
          [MSG.GAME_STATE]: (p) => {
            setGameState(p.state as Record<string, unknown>)
            setTick(p.tick)
            setPlayers(p.players as GamePlayer[])
            setRunning(p.running)
          },
          [MSG.GAME_TICK]: (p) => {
            setGameState(p.state as Record<string, unknown>)
            setTick(p.tick)
          },
          [MSG.GAME_PLAYER_JOIN]: (p) => {
            const player = p.player as GamePlayer
            setPlayers((prev) => [...prev.filter((x) => x.userId !== player.userId), player])
          },
          [MSG.GAME_PLAYER_LEAVE]: (p) => {
            setPlayers((prev) => prev.filter((x) => x.userId !== p.userId))
          },
          [MSG.GAME_PLAYER_READY]: (p) => {
            setPlayers((prev) =>
              prev.map((x) => (x.userId === p.userId ? { ...x, ready: true } : x)),
            )
          },
          [MSG.GAME_START]: (p) => {
            setRunning(true)
            setGameState(p.state as Record<string, unknown>)
            setTick(p.tick)
          },
          [MSG.GAME_END]: (p) => {
            setRunning(false)
            setGameState(p.state as Record<string, unknown>)
          },
        })
      }

      ws.onclose = () => {
        wsLog('disconnected', `game:${roomId}`)
        wsRef.current = null
        setConnected(false)
        // Reset to the safe default so a reconnect with a degraded role
        // doesn't leave input/control buttons enabled until the new AUTH
        // frame lands. See useCanvas onclose for the rationale.
        setCanWrite(false)
        if (alive) reconnectTimer = setTimeout(connect, 1000)
      }

      ws.onerror = () => ws?.close()
    }

    connect()

    return () => {
      wsLog('closing', `game:${roomId}`)
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
  }, [roomId])

  // Local write-gate. The server enforces the same rule in
  // GameRoom.onMessage; this is the UX side so spectator clicks don't
  // even leave the browser.
  const send = useCallback(
    <M extends { type: string; payload: unknown }>(message: M) => {
      if (!canWrite) return
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(encode(message))
    },
    [canWrite],
  )

  const sendInput = useCallback(
    (action: string, data: Record<string, unknown> = {}) => send(clientBuild.gameInput(action, data)),
    [send],
  )

  const setReady = useCallback(() => send(clientBuild.gamePlayerReady()), [send])
  const startGame = useCallback(() => send(clientBuild.gameStart()), [send])
  const endGame = useCallback(() => send(clientBuild.gameEnd()), [send])

  return { state: gameState, tick, players, running, connected, canWrite, sendInput, setReady, startGame, endGame }
}
