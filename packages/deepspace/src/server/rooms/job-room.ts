/**
 * JobRoom — Per-app durable background-job execution Durable Object.
 *
 * Solves the "long job dies when the response goes out" problem on
 * Cloudflare Workers. `ctx.waitUntil` only gets 30s after a response;
 * jobs that need minutes-to-hours live here instead: rows in SQLite,
 * picked up by DO alarms (15-min wall budget per tick), resumable
 * across ticks via `ctx.continue` for the rare longer cases.
 *
 * Lifecycle: queued → running → succeeded | failed | canceled
 *
 * Crash recovery: if an isolate is recycled mid-run, the row stays at
 * `running`. On next init, rows older than ~16 min are either retried
 * (if attempts left) or marked failed.
 *
 * See the abstract `onJob` method below for the subclass contract.
 * Message types: job.*
 */

/// <reference types="@cloudflare/workers-types" />

import { BaseRoom, type UserAttachment } from './base-room'
import { MSG } from '../../shared/protocol/constants'
import { serverBuild } from '../../shared/protocol/messages'

// ============================================================================
// Types
// ============================================================================

export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'

/**
 * Job record exposed to `onJob` handlers and clients. Payloads are typed
 * as `unknown` at the SDK layer; subclasses narrow via a generic param.
 */
export interface Job<P = unknown> {
  id: string
  type: string
  status: JobStatus
  payload: P
  result?: unknown
  error?: string
  progress?: number
  progressMessage?: string
  attempts: number
  maxAttempts: number
  enqueuedAt: string
  startedAt?: string | null
  completedAt?: string | null
  enqueuedBy?: string | null
  /** Set when a previous run called `ctx.continue(state)`. */
  resumeFrom?: unknown
}

export interface JobContext {
  /** Set progress (0..1) with an optional message. Broadcasts. */
  progress(value: number, message?: string): void
  /**
   * Save a resumable checkpoint and re-run `onJob` on the next alarm
   * with `job.resumeFrom = state`. The return value of `onJob` is
   * ignored once `continue` has been called.
   */
  continue(state: unknown, options?: { afterMs?: number }): void
  /**
   * Fires when a JOB_CANCEL arrives while this job is running in this
   * isolate. Cross-isolate cancels still mark the row `canceled` but
   * can't fire this signal.
   */
  signal: AbortSignal
}

export interface JobRoomConfig {
  /** Default for jobs enqueued without explicit `maxAttempts`. Default 1 (no auto-retry). */
  defaultMaxAttempts?: number
  /** TTL for terminal rows (succeeded/failed/canceled) in ms. Default 24h. */
  retentionMs?: number
  /** Job count in the initial snapshot to a new subscriber. Default 100. */
  snapshotLimit?: number
  /** Delay before a failed attempt is retried, in ms. Default 1000. */
  retryBackoffMs?: number
}

// ============================================================================
// Constants
// ============================================================================

/** 1 min past CF's 15-min alarm wall — anything older was killed, not running. */
const RUNNING_STALE_MS = 16 * 60 * 1000
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000
const DEFAULT_SNAPSHOT_LIMIT = 100

// ============================================================================
// JobRoom
// ============================================================================

export abstract class JobRoom<
  E = Record<string, unknown>,
  P = unknown,
  R = unknown,
> extends BaseRoom<E> {
  private initialized = false
  private readonly defaultMaxAttempts: number
  private readonly retentionMs: number
  private readonly snapshotLimit: number
  private readonly retryBackoffMs: number

  /** In-flight jobs in this isolate; lets same-isolate JOB_CANCEL fire the signal. */
  private readonly inFlight = new Map<string, AbortController>()

  /** Set by `ctx.continue` inside `executeJob`; reset before every run. */
  private continueState: { checkpoint: unknown; afterMs: number } | null = null

  constructor(state: DurableObjectState, env: unknown, config: JobRoomConfig = {}) {
    super(state, env)
    this.defaultMaxAttempts = Math.max(1, config.defaultMaxAttempts ?? 1)
    this.retentionMs = Math.max(0, config.retentionMs ?? DEFAULT_RETENTION_MS)
    this.snapshotLimit = Math.max(1, config.snapshotLimit ?? DEFAULT_SNAPSHOT_LIMIT)
    this.retryBackoffMs = Math.max(0, config.retryBackoffMs ?? 1000)
  }

  private ensureInitialized(): void {
    if (this.initialized) return
    this.initialized = true

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT,
        result TEXT,
        error TEXT,
        progress REAL,
        progress_message TEXT,
        checkpoint TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        enqueued_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        enqueued_by TEXT,
        next_run_at TEXT
      )
    `)

    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS jobs_status_next_run ON jobs (status, next_run_at)`,
    )
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS jobs_completed_at ON jobs (completed_at)`,
    )

    this.recoverStuckRunning()
    this.scheduleNextAlarm()
  }

  // ==========================================================================
  // BaseRoom Lifecycle
  // ==========================================================================

  async fetch(request: Request): Promise<Response> {
    this.ensureInitialized()
    return super.fetch(request)
  }

  protected onConnect(ws: WebSocket, user: UserAttachment): UserAttachment {
    this.ensureInitialized()
    this.sendTo(ws, serverBuild.jobSnapshot(this.getRecentJobs(this.snapshotLimit)))
    return user
  }

  protected async onMessage(
    ws: WebSocket,
    user: UserAttachment,
    message: { type: string; [key: string]: unknown },
  ): Promise<void> {
    this.ensureInitialized()
    const { type, payload } = message as {
      type: string
      payload: Record<string, unknown>
    }

    switch (type) {
      case MSG.JOB_ENQUEUE: {
        const requestId = String(payload.requestId ?? '')
        const jobType = String(payload.type ?? '')
        if (!jobType) {
          this.sendTo(ws, serverBuild.error('JOB_ENQUEUE missing type'))
          return
        }
        const job = this.insertJob({
          type: jobType,
          payload: payload.payload,
          maxAttempts:
            typeof payload.maxAttempts === 'number'
              ? Math.max(1, Math.floor(payload.maxAttempts))
              : undefined,
          enqueuedBy: user.userId,
        })
        // Send the requestId-echoing ack only to the enqueuer (so their
        // pending promise resolves) and broadcast the same job *without*
        // the requestId to all other subscribers (so they upsert into
        // their `jobs` list without seeing somebody else's correlation id).
        this.sendTo(ws, serverBuild.jobEnqueued(job, requestId))
        this.broadcast(serverBuild.jobEnqueued(job), ws)
        this.scheduleNextAlarm()
        break
      }

      case MSG.JOB_CANCEL: {
        const jobId = String(payload.jobId ?? '')
        if (!jobId) {
          this.sendTo(ws, serverBuild.error('JOB_CANCEL missing jobId'))
          return
        }
        this.cancelJob(jobId)
        break
      }

      case MSG.JOB_RETRY: {
        const jobId = String(payload.jobId ?? '')
        if (!jobId) {
          this.sendTo(ws, serverBuild.error('JOB_RETRY missing jobId'))
          return
        }
        this.retryJob(jobId)
        break
      }

      default:
        this.sendTo(ws, serverBuild.error(`Unknown job message type: ${type}`))
    }
  }

  protected async onAlarm(): Promise<void> {
    this.ensureInitialized()
    await this.drainDueJobs()
    this.pruneExpired()
    this.scheduleNextAlarm()
  }

  // ==========================================================================
  // HTTP — internal enqueue path for cross-isolate callers
  // ==========================================================================

  /**
   * One internal endpoint, `POST /enqueue`, used by the `enqueueJob`
   * helper at the bottom of this file. The room is not meant to be
   * reachable from the public internet; callers route through the app
   * worker (or call `this.enqueue(...)` directly from a subclass).
   *
   * Subclasses overriding `onRequest` should call `super.onRequest(req)`
   * for paths they don't handle.
   */
  protected async onRequest(request: Request): Promise<Response> {
    this.ensureInitialized()
    const url = new URL(request.url)
    if (request.method !== 'POST' || !url.pathname.endsWith('/enqueue')) {
      return new Response('Not Found', { status: 404 })
    }
    const body = (await request.json().catch(() => null)) as
      | { type?: unknown; payload?: unknown; maxAttempts?: unknown; enqueuedBy?: unknown }
      | null
    if (!body || typeof body.type !== 'string' || !body.type) {
      return new Response(JSON.stringify({ error: 'type required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const job = this.insertJob({
      type: body.type,
      payload: body.payload,
      maxAttempts:
        typeof body.maxAttempts === 'number'
          ? Math.max(1, Math.floor(body.maxAttempts))
          : undefined,
      enqueuedBy: typeof body.enqueuedBy === 'string' ? body.enqueuedBy : undefined,
    })
    this.broadcast(serverBuild.jobEnqueued(job))
    this.scheduleNextAlarm()
    return new Response(JSON.stringify({ job }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // ==========================================================================
  // Public enqueue surface (server-side callers in the same isolate)
  // ==========================================================================

  /**
   * Synchronously persist a new job and arm the alarm. Returns the new
   * job. This is the in-isolate path — useful for a subclass `onJob`
   * that wants to chain follow-up work without paying a fetch hop:
   *
   *   protected async onJob(job: Job, ctx: JobContext) {
   *     // ... do work ...
   *     if (needsFollowup) this.enqueue('followup', { parent: job.id })
   *   }
   *
   * Workers code that lives outside the DO isolate (HTTP routes, cron
   * tasks, server actions) cannot call this directly — they must go
   * through the `enqueueJob` helper at the bottom of this file, which
   * routes via the DO's `/enqueue` HTTP endpoint.
   */
  public enqueue(
    type: string,
    payload?: unknown,
    options?: { maxAttempts?: number; enqueuedBy?: string },
  ): Job {
    this.ensureInitialized()
    const job = this.insertJob({
      type,
      payload,
      maxAttempts: options?.maxAttempts,
      enqueuedBy: options?.enqueuedBy,
    })
    this.broadcast(serverBuild.jobEnqueued(job))
    this.scheduleNextAlarm()
    return job
  }

  // ==========================================================================
  // Mutation helpers
  // ==========================================================================

  private insertJob(input: {
    type: string
    payload?: unknown
    maxAttempts?: number
    enqueuedBy?: string
  }): Job {
    const id = crypto.randomUUID()
    const enqueuedAt = new Date().toISOString()
    const maxAttempts = Math.max(1, input.maxAttempts ?? this.defaultMaxAttempts)
    const payloadJson = input.payload === undefined ? null : safeStringify(input.payload)

    this.sql.exec(
      `INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, enqueued_at, enqueued_by, next_run_at)
       VALUES (?, ?, 'queued', ?, 0, ?, ?, ?, ?)`,
      id,
      input.type,
      payloadJson,
      maxAttempts,
      enqueuedAt,
      input.enqueuedBy ?? null,
      enqueuedAt,
    )

    return this.getJobById(id)!
  }

  private cancelJob(jobId: string): void {
    const row = this.sql
      .exec(`SELECT status FROM jobs WHERE id = ?`, jobId)
      .toArray()[0] as { status: JobStatus } | undefined
    if (!row) return
    // Terminal statuses are already resolved.
    if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'canceled') {
      return
    }
    const completedAt = new Date().toISOString()
    // We intentionally do NOT clear `progress` / `progress_message` here:
    // "canceled at 60%" is useful diagnostic info, unlike succeeded/failed
    // where the terminal state already implies completion. `checkpoint`
    // is internal scaffolding that has no purpose after cancellation.
    this.sql.exec(
      `UPDATE jobs
         SET status = 'canceled',
             completed_at = ?,
             checkpoint = NULL,
             next_run_at = NULL
       WHERE id = ?`,
      completedAt,
      jobId,
    )
    // Best-effort: fire the AbortSignal if the job is running in this isolate.
    const controller = this.inFlight.get(jobId)
    if (controller) controller.abort()
    const job = this.getJobById(jobId)
    if (job) this.broadcast(serverBuild.jobCanceled(job))
  }

  private retryJob(jobId: string): void {
    const row = this.sql
      .exec(`SELECT status, attempts, max_attempts FROM jobs WHERE id = ?`, jobId)
      .toArray()[0] as
      | { status: JobStatus; attempts: number; max_attempts: number }
      | undefined
    if (!row) return
    // Retry is only meaningful for terminal failures / cancels. Live jobs
    // are already on track; succeeded jobs should be re-enqueued fresh.
    if (row.status !== 'failed' && row.status !== 'canceled') return

    // Lift max_attempts so the manual retry actually has a budget to run
    // even if the previous attempts exhausted the original limit.
    const newMax = Math.max(row.max_attempts, row.attempts + 1)
    this.sql.exec(
      `UPDATE jobs
         SET status = 'queued',
             max_attempts = ?,
             error = NULL,
             result = NULL,
             completed_at = NULL,
             next_run_at = ?
       WHERE id = ?`,
      newMax,
      new Date().toISOString(),
      jobId,
    )
    const job = this.getJobById(jobId)
    if (job) this.broadcast(serverBuild.jobRetried(job))
    this.scheduleNextAlarm()
  }

  // ==========================================================================
  // Alarm / execution
  // ==========================================================================

  /**
   * Drain due jobs in FIFO order. All due jobs share the alarm's
   * 15-min wall budget (a CF property, not a per-job allocation).
   */
  private async drainDueJobs(): Promise<void> {
    // Freeze the cutoff at the start: rows whose `next_run_at` is
    // written during this drain (retries, `ctx.continue`) fall out
    // and pick up on the next alarm with a fresh budget. Without
    // this, `ctx.continue({ afterMs: 0 })` re-enters the same tick.
    const cutoff = new Date().toISOString()
    while (true) {
      const row = this.sql
        .exec(
          `SELECT * FROM jobs
            WHERE status = 'queued'
              AND (next_run_at IS NULL OR next_run_at <= ?)
            ORDER BY enqueued_at ASC
            LIMIT 1`,
          cutoff,
        )
        .toArray()[0] as unknown as JobRow | undefined
      if (!row) return
      await this.executeJob(row)
    }
  }

  private async executeJob(row: JobRow): Promise<void> {
    const startedAt = row.started_at ?? new Date().toISOString()
    const attemptsBefore = row.attempts
    const attempt = attemptsBefore + 1

    this.sql.exec(
      `UPDATE jobs SET status = 'running', started_at = ?, attempts = ? WHERE id = ?`,
      startedAt,
      attempt,
      row.id,
    )

    const controller = new AbortController()
    this.inFlight.set(row.id, controller)
    this.continueState = null

    const job: Job = {
      ...rowToJobView(row),
      status: 'running',
      attempts: attempt,
      startedAt,
    }

    let outcome: 'succeeded' | 'failed' | 'continued' = 'succeeded'
    let result: unknown
    let errorMessage: string | undefined

    try {
      const ctx = this.makeContext(row.id, controller.signal)
      result = await this.onJob(job as Job<P>, ctx)
      if (this.continueState) outcome = 'continued'
    } catch (e) {
      outcome = 'failed'
      errorMessage = e instanceof Error ? e.message : String(e)
      console.error(`[JobRoom] Job "${row.type}" (${row.id}) failed:`, e)
    } finally {
      this.inFlight.delete(row.id)
    }

    // Cancellation racing the finish: if a cancel landed while we were
    // running, the row is now 'canceled' and we should not overwrite it.
    const currentStatus = this.readStatus(row.id)
    if (currentStatus === 'canceled') {
      this.continueState = null
      return
    }

    if (outcome === 'continued') {
      const state = this.continueState!
      this.continueState = null
      const nextRunAt = new Date(Date.now() + Math.max(0, state.afterMs)).toISOString()
      this.sql.exec(
        `UPDATE jobs
           SET status = 'queued',
               checkpoint = ?,
               next_run_at = ?
         WHERE id = ?`,
        safeStringify(state.checkpoint),
        nextRunAt,
        row.id,
      )
      const updated = this.getJobById(row.id)
      if (updated) this.broadcast(serverBuild.jobProgress(updated))
      return
    }

    const completedAt = new Date().toISOString()

    if (outcome === 'succeeded') {
      this.sql.exec(
        `UPDATE jobs
           SET status = 'succeeded',
               result = ?,
               completed_at = ?,
               error = NULL,
               checkpoint = NULL,
               next_run_at = NULL,
               progress = NULL,
               progress_message = NULL
         WHERE id = ?`,
        result === undefined ? null : safeStringify(result),
        completedAt,
        row.id,
      )
      const updated = this.getJobById(row.id)
      if (updated) this.broadcast(serverBuild.jobSucceeded(updated))
      return
    }

    // Failure path. Retry if we have attempts left.
    if (attempt < row.max_attempts) {
      // Back off the retry by `retryBackoffMs` so a tight crash-loop
      // doesn't burn the alarm wall budget. Clear progress so the next
      // attempt starts fresh — a job that died at 80% should not show
      // "queued at 80%" until the retry handler reports its own progress.
      const nextRunAt = new Date(Date.now() + this.retryBackoffMs).toISOString()
      this.sql.exec(
        `UPDATE jobs
           SET status = 'queued',
               error = ?,
               next_run_at = ?,
               started_at = NULL,
               progress = NULL,
               progress_message = NULL
         WHERE id = ?`,
        errorMessage ?? 'unknown error',
        nextRunAt,
        row.id,
      )
      const updated = this.getJobById(row.id)
      if (updated) this.broadcast(serverBuild.jobRetried(updated))
      return
    }

    this.sql.exec(
      `UPDATE jobs
         SET status = 'failed',
             error = ?,
             completed_at = ?,
             checkpoint = NULL,
             next_run_at = NULL,
             progress = NULL,
             progress_message = NULL
       WHERE id = ?`,
      errorMessage ?? 'unknown error',
      completedAt,
      row.id,
    )
    const updated = this.getJobById(row.id)
    if (updated) this.broadcast(serverBuild.jobFailed(updated))
  }

  private makeContext(jobId: string, signal: AbortSignal): JobContext {
    return {
      progress: (value: number, message?: string) => {
        const clamped = Math.max(0, Math.min(1, value))
        this.sql.exec(
          `UPDATE jobs SET progress = ?, progress_message = ? WHERE id = ?`,
          clamped,
          message ?? null,
          jobId,
        )
        const updated = this.getJobById(jobId)
        if (updated) this.broadcast(serverBuild.jobProgress(updated))
      },
      continue: (state: unknown, options?: { afterMs?: number }) => {
        // Last call wins if invoked multiple times, matching the intuition
        // that handlers can revise their checkpoint as work progresses.
        this.continueState = {
          checkpoint: state,
          afterMs: Math.max(0, options?.afterMs ?? 0),
        }
      },
      signal,
    }
  }

  private readStatus(jobId: string): JobStatus | null {
    const row = this.sql
      .exec(`SELECT status FROM jobs WHERE id = ?`, jobId)
      .toArray()[0] as { status: JobStatus } | undefined
    return row?.status ?? null
  }

  // ==========================================================================
  // Scheduling / recovery / pruning
  // ==========================================================================

  private scheduleNextAlarm(): void {
    const row = this.sql
      .exec(
        `SELECT next_run_at FROM jobs
          WHERE status = 'queued'
          ORDER BY (next_run_at IS NULL) ASC, next_run_at ASC
          LIMIT 1`,
      )
      .toArray()[0] as { next_run_at: string | null } | undefined

    if (!row) return

    const now = Date.now()
    const target = row.next_run_at ? Math.max(now, new Date(row.next_run_at).getTime()) : now
    // 50ms floor so we don't thrash the alarm with sub-tick re-arms.
    this.state.storage.setAlarm(Math.max(target, now + 50))
  }

  private recoverStuckRunning(): void {
    const cutoff = new Date(Date.now() - RUNNING_STALE_MS).toISOString()
    const stuck = this.sql
      .exec(
        `SELECT id, attempts, max_attempts FROM jobs
          WHERE status = 'running' AND started_at < ?`,
        cutoff,
      )
      .toArray() as { id: string; attempts: number; max_attempts: number }[]

    for (const r of stuck) {
      if (r.attempts >= r.max_attempts) {
        this.sql.exec(
          `UPDATE jobs
             SET status = 'failed',
                 error = 'Isolate recycled or wall time exceeded',
                 completed_at = ?,
                 checkpoint = NULL,
                 next_run_at = NULL
           WHERE id = ?`,
          new Date().toISOString(),
          r.id,
        )
      } else {
        this.sql.exec(
          `UPDATE jobs
             SET status = 'queued',
                 started_at = NULL,
                 next_run_at = ?,
                 error = 'Previous attempt killed mid-run; retrying',
                 progress = NULL,
                 progress_message = NULL
           WHERE id = ?`,
          new Date().toISOString(),
          r.id,
        )
      }
    }
  }

  private pruneExpired(): void {
    if (this.retentionMs === 0) return
    const cutoff = new Date(Date.now() - this.retentionMs).toISOString()
    this.sql.exec(
      `DELETE FROM jobs
        WHERE status IN ('succeeded', 'failed', 'canceled')
          AND completed_at IS NOT NULL
          AND completed_at < ?`,
      cutoff,
    )
  }

  // ==========================================================================
  // Read helpers
  // ==========================================================================

  private getRecentJobs(limit: number): Job[] {
    const rows = this.sql
      .exec(
        `SELECT * FROM jobs
          ORDER BY (status IN ('queued','running')) DESC, enqueued_at DESC
          LIMIT ?`,
        limit,
      )
      .toArray() as unknown as JobRow[]
    return rows.map(rowToJobView)
  }

  private getJobById(id: string): Job | null {
    const row = this.sql.exec(`SELECT * FROM jobs WHERE id = ?`, id).toArray()[0] as unknown as
      | JobRow
      | undefined
    return row ? rowToJobView(row) : null
  }

  // ==========================================================================
  // Handler — subclass implements
  // ==========================================================================

  /**
   * Run a single job. Return a value for success; throw for failure
   * (retried until attempts >= maxAttempts). Use `ctx.progress` for
   * progress, `ctx.continue(state)` to span multiple alarms, and
   * `ctx.signal` to honor client cancellations.
   */
  protected abstract onJob(job: Job<P>, ctx: JobContext): Promise<R | void> | R | void
}

// ============================================================================
// Cross-isolate enqueue helper
// ============================================================================

/**
 * Enqueue a job from worker code that has the DO namespace. Routed by
 * `roomId` (typically `app:<APP_NAME>`; pass different ids for sharded
 * queues). Returns the new jobId; throws on failure.
 *
 *   const jobId = await enqueueJob(
 *     env.JOB_ROOMS,
 *     `app:${env.APP_NAME}`,
 *     'ai-summarize',
 *     { text },
 *     { maxAttempts: 3 },
 *   )
 */
export async function enqueueJob(
  namespace: DurableObjectNamespace,
  roomId: string,
  type: string,
  payload?: unknown,
  options?: { maxAttempts?: number; enqueuedBy?: string },
): Promise<string> {
  const stub = namespace.get(namespace.idFromName(roomId))
  const res = await stub.fetch(
    new Request('https://job-room.internal/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        payload,
        maxAttempts: options?.maxAttempts,
        enqueuedBy: options?.enqueuedBy,
      }),
    }),
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`enqueueJob failed: ${res.status} ${text}`)
  }
  const data = (await res.json()) as { job?: { id?: string } }
  if (!data.job?.id) throw new Error('enqueueJob: malformed response')
  return data.job.id
}

// ============================================================================
// Internals
// ============================================================================

interface JobRow {
  id: string
  type: string
  status: JobStatus
  payload: string | null
  result: string | null
  error: string | null
  progress: number | null
  progress_message: string | null
  checkpoint: string | null
  attempts: number
  max_attempts: number
  enqueued_at: string
  started_at: string | null
  completed_at: string | null
  enqueued_by: string | null
  next_run_at: string | null
}

function rowToJobView(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    payload: row.payload == null ? undefined : JSON.parse(row.payload),
    result: row.result == null ? undefined : JSON.parse(row.result),
    error: row.error ?? undefined,
    progress: row.progress ?? undefined,
    progressMessage: row.progress_message ?? undefined,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    enqueuedBy: row.enqueued_by,
    resumeFrom: row.checkpoint == null ? undefined : JSON.parse(row.checkpoint),
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    // Fallback so cyclic payloads don't break the insert.
    return JSON.stringify({ __unserializable__: String(value) })
  }
}

