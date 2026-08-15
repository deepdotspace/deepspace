/**
 * useCronMonitor — Connect to a CronRoom for monitoring scheduled tasks.
 *
 * Opens a WebSocket to /cron/:roomId for real-time task status.
 *
 * @example
 * const { tasks, history, trigger, pause, resume } = useCronMonitor('cron')
 *
 * async function onRunNow() {
 *   const receipt = await trigger('daily-digest')
 *   if (!receipt.ok) toast(receipt.error ?? receipt.reason)
 * }
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

/**
 * Outcome of a cron mutation (trigger / pause / resume). Failures are
 * typed by origin: `read_only` and `not_connected` short-circuit locally
 * without sending a frame; `unknown_task` and `failed` come back in the
 * server's CRON_ACK receipt. Triggers execute synchronously in the DO
 * before the receipt is sent, so an ok trigger result means the run
 * completed — its execution record (duration, errors) arrives via
 * `history`.
 */
export type CronMutationResult =
  | { ok: true; taskName: string; requestId: string }
  | {
      ok: false
      reason: 'read_only' | 'not_connected' | 'unknown_task' | 'failed'
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
   * mutation callbacks below resolve `{ ok: false, reason: 'read_only' }`
   * and UIs should disable those controls. Reading tasks/history stays
   * available either way.
   */
  canWrite: boolean
  /**
   * Most recent ERROR frame from the room (e.g. a write rejected by a
   * concurrent role change). Null until one arrives.
   */
  lastError: string | null
  /** Manually trigger a task; resolves once the run completes. */
  trigger: (taskName: string) => Promise<CronMutationResult>
  /** Pause a task; resolves once the server applies it. */
  pause: (taskName: string) => Promise<CronMutationResult>
  /** Resume a paused task; resolves once the server applies it. */
  resume: (taskName: string) => Promise<CronMutationResult>
}

export function useCronMonitor(roomId: string): UseCronMonitorResult {
  const [tasks, setTasks] = useState<CronTaskState[]>([])
  const [history, setHistory] = useState<CronHistoryEntry[]>([])
  const [connected, setConnected] = useState(false)
  // Default false: viewers/anon connections can read but not write. The
  // server's CronRoom.onConnect AUTH frame flips this for members/admins.
  const [canWrite, setCanWrite] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  /**
   * Pending mutation resolvers keyed by requestId. No per-entry timeout:
   * triggers run to completion inline in the DO, so a long task's receipt
   * is legitimately slow; the socket-close drain below settles anything
   * the server can no longer answer.
   */
  const pendingRef = useRef<Map<string, (result: CronMutationResult) => void>>(new Map())

  useEffect(() => {
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let alive = true

    const drainPending = (result: CronMutationResult) => {
      for (const resolve of pendingRef.current.values()) resolve(result)
      pendingRef.current.clear()
    }

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
          [MSG.CRON_ACK]: (p) => {
            const resolve = pendingRef.current.get(p.requestId)
            if (!resolve) return
            pendingRef.current.delete(p.requestId)
            resolve(
              p.ok
                ? { ok: true, taskName: p.taskName, requestId: p.requestId }
                : { ok: false, reason: p.reason, error: p.error },
            )
          },
          [MSG.ERROR]: (p) => {
            setLastError(p.error)
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
        drainPending({ ok: false, reason: 'not_connected' })
        if (alive) reconnectTimer = setTimeout(connect, 1000)
      }

      ws.onerror = () => ws?.close()
    }

    connect()

    return () => {
      alive = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      drainPending({ ok: false, reason: 'not_connected' })
      ws?.close()
      wsRef.current = null
    }
  }, [roomId])

  // Local write-gate. Mirrors the server check in CronRoom.onMessage so a
  // viewer's click resolves `read_only` locally instead of round-tripping
  // to ERROR. Connected sends register a resolver under a fresh requestId;
  // the room's CRON_ACK receipt settles the promise.
  const sendWrite = useCallback(
    <M extends { type: string; payload: unknown }>(
      build: (requestId: string) => M,
    ): Promise<CronMutationResult> => {
      // Each new mutation starts with a clean slate so a surfaced ERROR
      // always belongs to the latest attempt, not a stale earlier one.
      setLastError(null)
      if (!canWrite) return Promise.resolve({ ok: false, reason: 'read_only' })
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.resolve({ ok: false, reason: 'not_connected' })
      }
      return new Promise((resolve) => {
        const requestId = crypto.randomUUID()
        pendingRef.current.set(requestId, resolve)
        // ws.send can throw synchronously if the socket transitions between
        // the readyState check and the call; without this guard the pending
        // entry would only settle on the next socket close.
        try {
          ws.send(encode(build(requestId)))
        } catch (e) {
          pendingRef.current.delete(requestId)
          resolve({
            ok: false,
            reason: 'not_connected',
            error: e instanceof Error ? e.message : String(e),
          })
        }
      })
    },
    [canWrite],
  )

  const trigger = useCallback(
    (taskName: string) => sendWrite((requestId) => clientBuild.cronTrigger(taskName, requestId)),
    [sendWrite],
  )
  const pause = useCallback(
    (taskName: string) => sendWrite((requestId) => clientBuild.cronPause(taskName, requestId)),
    [sendWrite],
  )
  const resume = useCallback(
    (taskName: string) => sendWrite((requestId) => clientBuild.cronResume(taskName, requestId)),
    [sendWrite],
  )

  return { tasks, history, connected, canWrite, lastError, trigger, pause, resume }
}
