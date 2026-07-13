/**
 * useCronMonitor — Connect to a CronRoom for monitoring scheduled tasks.
 *
 * Opens a WebSocket to /cron/:roomId for real-time task status.
 *
 * @example
 * const { tasks, history, trigger, pause, resume } = useCronMonitor('cron')
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { getAuthToken } from '../../auth'
import { MSG } from '@/shared/protocol/constants'
import {
  clientBuild,
  dispatch,
  encode,
  type ServerMessage,
} from '@/shared/protocol/messages'

export interface CronTaskState {
  name: string
  intervalMinutes: number | null
  schedule: string | null
  timezone: string | null
  paused: boolean
  lastRunAt: string | null
  nextRunAt: string | null
}

export interface CronHistoryEntry {
  taskName: string
  startedAt: string
  completedAt: string | null
  success: boolean
  durationMs: number
  error?: string
}

export interface UseCronMonitorResult {
  /** Current task states */
  tasks: CronTaskState[]
  /** Execution history */
  history: CronHistoryEntry[]
  /** Whether WebSocket is connected */
  connected: boolean
  /**
   * Whether this connection can mutate cron state (trigger / pause /
   * resume). False for viewers and unauthenticated connections — the
   * mutation callbacks below no-op and UIs should disable those
   * controls. Reading tasks/history stays available either way.
   */
  canWrite: boolean
  /** Manually trigger a task (no-op when canWrite is false) */
  trigger: (taskName: string) => void
  /** Pause a task (no-op when canWrite is false) */
  pause: (taskName: string) => void
  /** Resume a paused task (no-op when canWrite is false) */
  resume: (taskName: string) => void
}

export function useCronMonitor(roomId: string): UseCronMonitorResult {
  const [tasks, setTasks] = useState<CronTaskState[]>([])
  const [history, setHistory] = useState<CronHistoryEntry[]>([])
  const [connected, setConnected] = useState(false)
  // Default false: viewers/anon connections can read but not write. The
  // server's CronRoom.onConnect AUTH frame flips this for members/admins.
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
      const url = new URL(`/ws/cron/${encodeURIComponent(roomId)}`, baseUrl)
      if (token) url.searchParams.set('token', token)

      ws = new WebSocket(url.toString())
      wsRef.current = ws

      ws.onopen = () => setConnected(true)

      ws.onmessage = (event) => {
        dispatch<ServerMessage>(event.data, {
          [MSG.AUTH]: (p) => {
            setCanWrite(p.canWrite)
          },
          [MSG.CRON_TASKS]: (p) => {
            setTasks(p.tasks as CronTaskState[])
          },
          [MSG.CRON_HISTORY]: (p) => {
            setHistory(p.history as CronHistoryEntry[])
          },
          [MSG.CRON_STATUS]: (p) => {
            setTasks(p.tasks as CronTaskState[])
            setHistory(p.recentHistory as CronHistoryEntry[])
          },
        })
      }

      ws.onclose = () => {
        wsRef.current = null
        setConnected(false)
        // Reset to the safe default so a reconnect with a degraded role
        // doesn't leave trigger/pause/resume controls enabled until the
        // new AUTH frame lands. See useCanvas onclose for the rationale.
        setCanWrite(false)
        if (alive) reconnectTimer = setTimeout(connect, 1000)
      }

      ws.onerror = () => ws?.close()
    }

    connect()

    return () => {
      alive = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
      wsRef.current = null
    }
  }, [roomId])

  // Local write-gate. Mirrors the server check in CronRoom.onMessage so
  // viewer clicks short-circuit instead of round-tripping to ERROR.
  const sendWrite = useCallback(
    <M extends { type: string; payload: unknown }>(message: M) => {
      if (!canWrite) return
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(encode(message))
    },
    [canWrite],
  )

  const trigger = useCallback(
    (taskName: string) => sendWrite(clientBuild.cronTrigger(taskName)),
    [sendWrite],
  )
  const pause = useCallback(
    (taskName: string) => sendWrite(clientBuild.cronPause(taskName)),
    [sendWrite],
  )
  const resume = useCallback(
    (taskName: string) => sendWrite(clientBuild.cronResume(taskName)),
    [sendWrite],
  )

  return { tasks, history, connected, canWrite, trigger, pause, resume }
}
