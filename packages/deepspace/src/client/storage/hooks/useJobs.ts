/**
 * useJobs — Connect to a JobRoom for enqueueing and tracking background
 * jobs in real time.
 *
 * Opens a WebSocket to /ws/jobs/:roomId. The DO pushes a snapshot on
 * connect and JOB_UPDATE messages for every state change after that, so
 * `jobs` stays current without polling. `enqueue` returns a promise that
 * resolves with the new jobId once the server acks.
 *
 * Client-side names (`JobView`, `JobStatusView`) differ from the
 * server-side equivalents (`Job`, `JobStatus` in `deepspace/worker`) so
 * apps importing from both ends don't get type collisions.
 *
 * @example
 * const { jobs, enqueue, getJob, cancel } = useJobs(`app:${APP_NAME}`)
 *
 * async function onClick() {
 *   const jobId = await enqueue('ai-summarize', { text })
 *   // Now `getJob(jobId)` is reactive until the job reaches a terminal state.
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

/** How long enqueue() waits for a server ack before rejecting. */
const ENQUEUE_TIMEOUT_MS = 10_000

export type JobStatusView =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export interface JobView<P = unknown, R = unknown> {
  id: string
  type: string
  status: JobStatusView
  payload?: P
  result?: R
  error?: string
  progress?: number
  progressMessage?: string
  attempts: number
  maxAttempts: number
  enqueuedAt: string
  startedAt?: string | null
  completedAt?: string | null
  enqueuedBy?: string | null
}

export interface UseJobsResult<P = unknown, R = unknown> {
  /** All jobs the room currently knows about, newest-first. */
  jobs: JobView<P, R>[]
  /** WebSocket connection state. */
  connected: boolean
  /**
   * Enqueue a new job. Resolves with the new jobId once the server acks
   * (typically <100ms). Rejects if:
   *   - the WebSocket isn't connected
   *   - the WebSocket closes before the ack arrives
   *   - no ack arrives within 10s (server dropped the message)
   */
  enqueue(
    type: string,
    payload?: P,
    options?: { maxAttempts?: number },
  ): Promise<string>
  /**
   * Reactive single-job lookup. Returns undefined while the snapshot is
   * loading or if the job has been GC'd by the room's TTL sweep.
   */
  getJob(jobId: string): JobView<P, R> | undefined
  /** Best-effort cancel. The job is marked canceled even if the handler ignores `ctx.signal`. */
  cancel(jobId: string): void
  /** Manually re-queue a failed/canceled job. No-op for other statuses. */
  retry(jobId: string): void
}

interface PendingEnqueue {
  resolve: (id: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * @param roomId DO room id, typically `app:<APP_NAME>`. Apps with sharded
 *   queues pass different ids — each id maps to its own DO instance.
 */
export function useJobs<P = unknown, R = unknown>(
  roomId: string,
): UseJobsResult<P, R> {
  const [jobs, setJobs] = useState<JobView<P, R>[]>([])
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  /**
   * Pending enqueue promises keyed by requestId. Each entry carries a
   * timeout timer so the caller doesn't hang forever if the server drops
   * the enqueue (validation error swallowed, isolate restart, etc.).
   */
  const pendingEnqueueRef = useRef<Map<string, PendingEnqueue>>(new Map())

  useEffect(() => {
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let alive = true

    const upsert = (next: JobView<P, R>) => {
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.id === next.id)
        if (idx === -1) return [next, ...prev]
        const copy = prev.slice()
        copy[idx] = next
        return copy
      })
    }

    const rejectAllPending = (err: Error) => {
      for (const [id, pending] of pendingEnqueueRef.current.entries()) {
        clearTimeout(pending.timer)
        pending.reject(err)
        pendingEnqueueRef.current.delete(id)
      }
    }

    const connect = async () => {
      if (!alive) return

      const token = await getAuthToken()
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const baseUrl = `${protocol}//${window.location.host}`
      const url = new URL(`/ws/jobs/${encodeURIComponent(roomId)}`, baseUrl)
      if (token) url.searchParams.set('token', token)

      ws = new WebSocket(url.toString())
      wsRef.current = ws

      ws.onopen = () => setConnected(true)

      ws.onmessage = (event) => {
        dispatch<ServerMessage>(event.data, {
          [MSG.JOB_UPDATE]: (p) => {
            if (p.kind === 'snapshot' && Array.isArray(p.jobs)) {
              setJobs(p.jobs as JobView<P, R>[])
              return
            }
            const job = p.job as JobView<P, R> | undefined
            if (!job) return
            upsert(job)
            // Resolve the enqueue promise once the server acks.
            if (p.kind === 'enqueued' && typeof p.requestId === 'string') {
              const pending = pendingEnqueueRef.current.get(p.requestId)
              if (pending) {
                clearTimeout(pending.timer)
                pendingEnqueueRef.current.delete(p.requestId)
                pending.resolve(job.id)
              }
            }
          },
        })
      }

      ws.onclose = () => {
        wsRef.current = null
        setConnected(false)
        rejectAllPending(new Error('JobRoom WebSocket closed'))
        if (alive) reconnectTimer = setTimeout(connect, 1000)
      }

      ws.onerror = () => ws?.close()
    }

    connect()

    return () => {
      alive = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      rejectAllPending(new Error('useJobs unmounted'))
      ws?.close()
      wsRef.current = null
    }
  }, [roomId])

  const enqueue = useCallback(
    (type: string, payload?: P, options?: { maxAttempts?: number }) => {
      return new Promise<string>((resolve, reject) => {
        const ws = wsRef.current
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error('JobRoom WebSocket not connected'))
          return
        }
        const requestId = crypto.randomUUID()
        const timer = setTimeout(() => {
          pendingEnqueueRef.current.delete(requestId)
          reject(
            new Error(
              `JobRoom enqueue timed out (no server ack within ${ENQUEUE_TIMEOUT_MS}ms)`,
            ),
          )
        }, ENQUEUE_TIMEOUT_MS)
        pendingEnqueueRef.current.set(requestId, { resolve, reject, timer })
        // ws.send can throw synchronously if the socket transitions between
        // the readyState check and the call (browser-specific, quota errors).
        // Without this guard the pending entry would sit until the 10s
        // timeout — fine for safety, bad for caller latency.
        try {
          ws.send(
            encode(clientBuild.jobEnqueue(requestId, type, payload, options?.maxAttempts)),
          )
        } catch (e) {
          clearTimeout(timer)
          pendingEnqueueRef.current.delete(requestId)
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
    },
    [],
  )

  const sendBuilt = useCallback(
    <M extends { type: string; payload: unknown }>(message: M): void => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(encode(message))
    },
    [],
  )

  const getJob = useCallback(
    (jobId: string) => jobs.find((j) => j.id === jobId),
    [jobs],
  )

  const cancel = useCallback(
    (jobId: string) => sendBuilt(clientBuild.jobCancel(jobId)),
    [sendBuilt],
  )

  const retry = useCallback(
    (jobId: string) => sendBuilt(clientBuild.jobRetry(jobId)),
    [sendBuilt],
  )

  return { jobs, connected, enqueue, getJob, cancel, retry }
}
