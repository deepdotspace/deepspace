/**
 * CronRoom — Per-app scheduled task execution Durable Object.
 *
 * Extends BaseRoom. One DO per app shards cron work and avoids the
 * dispatch-worker's global KV-poll bottleneck. The DO alarm triggers
 * `onTask(name)` on the configured cadence; each execution is recorded
 * to a per-app `cron_history` table. Subscribers (admin clients via the
 * `useCronMonitor` hook) get pushes over the WebSocket.
 *
 * Tasks declare *either* `intervalMinutes` (run every N minutes) *or*
 * `schedule` + `timezone` (5-field cron expression evaluated against an
 * IANA timezone via `Intl.DateTimeFormat`). Cron mode is DST-aware
 * because the wall-clock comparison happens after the timezone shift,
 * not before.
 *
 * Message types: cron.*
 */

/// <reference types="@cloudflare/workers-types" />

import { BaseRoom, type UserAttachment } from './base-room'
import { nextCronFire, validateTask, type CronTask } from './cron-schedule'
import { loggableError } from '../../shared/log-events'
import { MSG } from '../../shared/protocol/constants'
import { serverBuild } from '../../shared/protocol/messages'
import { ROLES } from '../../shared/roles'

// ============================================================================
// Types
// ============================================================================

export interface CronRoomConfig {
  tasks: CronTask[]
}

export interface CronExecution {
  taskName: string
  startedAt: string
  completedAt: string | null
  success: boolean
  durationMs: number
  error?: string
}

/** The `cron_tasks` columns that decide when a task runs next. */
type TaskSchedule = {
  interval_minutes: number | null
  schedule: string | null
  timezone: string | null
}

interface CronAttachment extends UserAttachment {
  /** True for member/admin roles; false for viewers and unauthenticated anon. */
  canWrite: boolean
}

/**
 * `GET /internal/cron/tasks` on the room's stub — the request `armCronRoom`
 * sends. Reachable only by DO-stub fetch from the app worker (see the security
 * note on `BaseRoom.fetch`); answers `{ tasks }` in the `cron.tasks` shape.
 */
export const CRON_TASKS_INTERNAL_PATH = '/internal/cron/tasks'

// A run still open this long was abandoned without its isolate restarting:
// alarm handlers are cut off after 15 minutes (the same bound JobRoom uses).
const ABANDONED_RUN_MS = 16 * 60 * 1000

// Cron commands that mutate scheduler state. Read-only messages
// (CRON_TASKS, CRON_HISTORY) are allowed for any connected client per the
// SDK contract that viewers can observe but not write.
const CRON_WRITE_TYPES: ReadonlySet<string> = new Set([
  MSG.CRON_TRIGGER,
  MSG.CRON_PAUSE,
  MSG.CRON_RESUME,
])

// ============================================================================
// CronRoom
// ============================================================================

export abstract class CronRoom<E = Record<string, unknown>> extends BaseRoom<E> {
  private tasks: CronTask[]
  private initialized = false

  constructor(state: DurableObjectState, env: unknown, config: CronRoomConfig) {
    super(state, env)
    // Validate at construction time — bad configs should never reach DB.
    this.tasks = config.tasks.map(validateTask)
  }

  private ensureInitialized(): void {
    if (this.initialized) return
    this.initialized = true

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS cron_tasks (
        name TEXT PRIMARY KEY,
        interval_minutes INTEGER,
        schedule TEXT,
        timezone TEXT,
        paused INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT,
        next_run_at TEXT
      )
    `)

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS cron_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        success INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL
      )
    `)

    // This runs once per isolate before any run starts, so every open run
    // belongs to an isolate that was reset mid-task.
    this.closeInterruptedRuns(Date.now())

    // Sync configured tasks. Insert new ones; refresh schedule/interval/timezone
    // on existing ones (so editing src/cron.ts and re-deploying picks up the
    // change without a manual reset). Preserve last_run_at / paused. A changed
    // schedule clears next_run_at, so the task gets a new slot below.
    for (const task of this.tasks) {
      const existing = this.sql
        .exec(`SELECT name FROM cron_tasks WHERE name = ?`, task.name)
        .toArray()
      if (existing.length === 0) {
        this.sql.exec(
          `INSERT INTO cron_tasks (name, interval_minutes, schedule, timezone, paused)
           VALUES (?, ?, ?, ?, ?)`,
          task.name,
          task.intervalMinutes ?? null,
          task.schedule ?? null,
          task.timezone ?? null,
          task.paused ? 1 : 0,
        )
      } else {
        const timing = [task.intervalMinutes ?? null, task.schedule ?? null, task.timezone ?? null]
        this.sql.exec(
          `UPDATE cron_tasks
             SET next_run_at = CASE WHEN interval_minutes IS ? AND schedule IS ? AND timezone IS ?
                                    THEN next_run_at END,
                 interval_minutes = ?, schedule = ?, timezone = ?
           WHERE name = ?`,
          ...timing,
          ...timing,
          task.name,
        )
      }
    }

    // Remove tasks no longer in config
    const configNames = new Set(this.tasks.map((t) => t.name))
    const dbTasks = this.sql.exec(`SELECT name FROM cron_tasks`).toArray()
    for (const row of dbTasks) {
      if (!configNames.has((row as { name: string }).name)) {
        this.sql.exec(`DELETE FROM cron_tasks WHERE name = ?`, (row as { name: string }).name)
      }
    }

    // Give each task without a slot (new, or its schedule just changed) one:
    // an interval task runs now, a scheduled task at its next matching minute.
    // A task left without a slot (a schedule with no matching minute) is never
    // due.
    const now = new Date()
    const unscheduled = this.sql
      .exec(
        `SELECT name, interval_minutes, schedule, timezone FROM cron_tasks WHERE next_run_at IS NULL`,
      )
      .toArray() as (TaskSchedule & { name: string })[]
    for (const task of unscheduled) {
      const first = task.interval_minutes ? now.toISOString() : computeNextRunAt(task, now)
      if (!first)
        console.error(`[cron] ${task.name} never runs: "${task.schedule}" has no upcoming time`)
      this.sql.exec(`UPDATE cron_tasks SET next_run_at = ? WHERE name = ?`, first, task.name)
    }

    // Schedule the next alarm
    this.scheduleNextAlarm()
  }

  // ==========================================================================
  // BaseRoom Lifecycle
  // ==========================================================================

  async fetch(request: Request): Promise<Response> {
    this.ensureInitialized()
    return super.fetch(request)
  }

  protected async handleInternalRequest(request: Request, url: URL): Promise<Response | null> {
    if (request.method === 'GET' && url.pathname === CRON_TASKS_INTERNAL_PATH) {
      return Response.json({ tasks: this.getTaskStates() })
    }
    return super.handleInternalRequest(request, url)
  }

  protected onConnect(ws: WebSocket, user: UserAttachment): CronAttachment {
    this.ensureInitialized()

    const role = (user.role as string | undefined) ?? ROLES.VIEWER
    const canWrite = role === ROLES.MEMBER || role === ROLES.ADMIN

    // Tell the client whether trigger / pause / resume will be accepted,
    // so the monitor UI can render those controls as disabled for viewers
    // instead of trying and surfacing an ERROR after the fact.
    this.sendTo(ws, { type: MSG.AUTH, payload: { canWrite } })

    // Send current task list and recent history
    this.sendTo(ws, {
      type: MSG.CRON_TASKS,
      payload: { tasks: this.getTaskStates() },
    })

    this.sendTo(ws, {
      type: MSG.CRON_HISTORY,
      payload: { history: this.getRecentHistory(50) },
    })

    return { ...user, canWrite }
  }

  protected async onMessage(
    ws: WebSocket,
    user: UserAttachment,
    message: { type: string; [key: string]: unknown },
  ): Promise<void> {
    this.ensureInitialized()
    // Default `payload` so a payload-less frame reaches the typed reject
    // paths below instead of throwing into BaseRoom's catch-all logger.
    const { type, payload = {} } = message as { type: string; payload?: Record<string, unknown> }

    if (CRON_WRITE_TYPES.has(type) && !(user as CronAttachment).canWrite) {
      const error = 'Write access denied: viewer role cannot modify cron tasks'
      this.sendTo(ws, { type: MSG.ERROR, payload: { error } })
      this.ackMutation(ws, payload.requestId, {
        ok: false,
        taskName: payload.taskName as string | undefined,
        reason: 'read_only',
        error,
      })
      return
    }

    try {
      await this.dispatchMessage(ws, type, payload)
    } catch (error) {
      // A mid-operation throw (storage, alarm scheduling, broadcast) must
      // still settle the caller's receipt — an unacked requestId would leave
      // the client's mutation promise pending until unmount.
      try {
        this.ackMutation(ws, payload.requestId, {
          ok: false,
          taskName: payload.taskName as string | undefined,
          reason: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
      } catch {
        // Socket already dead — the client's onclose drains its pendings.
      }
      throw error
    }
  }

  private async dispatchMessage(
    ws: WebSocket,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    switch (type) {
      case MSG.CRON_TRIGGER: {
        const taskName = payload.taskName as string
        if (!taskName) {
          const error = 'Missing taskName'
          this.sendTo(ws, { type: MSG.ERROR, payload: { error } })
          this.ackMutation(ws, payload.requestId, { ok: false, reason: 'failed', error })
          return
        }
        const execution = await this.executeTask(taskName)
        if (!execution) {
          const error = `Unknown cron task: ${taskName}`
          this.sendTo(ws, { type: MSG.ERROR, payload: { error } })
          this.ackMutation(ws, payload.requestId, {
            ok: false,
            taskName,
            reason: 'unknown_task',
            error,
          })
          break
        }
        this.ackMutation(
          ws,
          payload.requestId,
          execution.success
            ? { ok: true, taskName }
            : { ok: false, taskName, reason: 'failed', error: execution.error },
        )
        break
      }

      case MSG.CRON_PAUSE:
      case MSG.CRON_RESUME: {
        const taskName = payload.taskName as string
        if (!taskName) {
          const error = 'Missing taskName'
          this.sendTo(ws, { type: MSG.ERROR, payload: { error } })
          this.ackMutation(ws, payload.requestId, { ok: false, reason: 'failed', error })
          return
        }
        // Same rejection contract as CRON_TRIGGER: a name the scheduler does
        // not know must never ack ok — the UPDATE below would match zero rows
        // and the receipt would report a state flip that never happened.
        const known =
          this.sql.exec(`SELECT name FROM cron_tasks WHERE name = ?`, taskName).toArray().length > 0
        if (!known) {
          const error = `Unknown cron task: ${taskName}`
          this.sendTo(ws, { type: MSG.ERROR, payload: { error } })
          this.ackMutation(ws, payload.requestId, {
            ok: false,
            taskName,
            reason: 'unknown_task',
            error,
          })
          break
        }
        const paused = type === MSG.CRON_PAUSE
        this.sql.exec(`UPDATE cron_tasks SET paused = ? WHERE name = ?`, paused ? 1 : 0, taskName)
        if (!paused) this.scheduleNextAlarm()
        this.broadcastStatus()
        this.ackMutation(ws, payload.requestId, { ok: true, taskName })
        break
      }

      case MSG.CRON_TASKS: {
        this.sendTo(ws, {
          type: MSG.CRON_TASKS,
          payload: { tasks: this.getTaskStates() },
        })
        break
      }

      case MSG.CRON_HISTORY: {
        const limit = (payload.limit as number) ?? 50
        this.sendTo(ws, {
          type: MSG.CRON_HISTORY,
          payload: { history: this.getRecentHistory(limit) },
        })
        break
      }

      default:
        this.sendTo(ws, {
          type: MSG.ERROR,
          payload: { error: `Unknown cron message type: ${type}` },
        })
    }
  }

  protected async onAlarm(): Promise<void> {
    this.ensureInitialized()
    const now = new Date()
    this.closeInterruptedRuns(now.getTime() - ABANDONED_RUN_MS)

    // Run due tasks one at a time, longest overdue first and in first-added
    // order on a tie. Each pick re-reads the table, so a task claimed by a
    // manual trigger or paused meanwhile is not run again. A claim moves
    // next_run_at past `now`, so a task whose runs keep dying cannot hold the
    // head of the line, and the loop ends.
    for (;;) {
      const task = this.sql
        .exec(
          `SELECT name FROM cron_tasks WHERE paused = 0 AND next_run_at <= ?
           ORDER BY next_run_at, rowid LIMIT 1`,
          now.toISOString(),
        )
        .toArray()[0] as { name: string } | undefined
      if (!task) break
      await this.executeTask(task.name)
    }

    this.scheduleNextAlarm()
  }

  // ==========================================================================
  // Task Execution
  // ==========================================================================

  private async executeTask(taskName: string): Promise<CronExecution | null> {
    // Resolve the configured task before invoking application code. A manual
    // trigger must not turn an arbitrary caller-provided name into a reported
    // successful execution.
    const taskRow = this.sql
      .exec(`SELECT interval_minutes, schedule, timezone FROM cron_tasks WHERE name = ?`, taskName)
      .toArray()[0] as TaskSchedule | undefined
    if (!taskRow) return null

    // Claim the run and open its history row on disk before invoking
    // application code. If the isolate is reset mid-task, the task waits for
    // its next slot instead of re-running on every alarm retry and starving
    // the tasks queued behind it, and the run is later closed as interrupted.
    const startedAt = new Date().toISOString()
    this.recordRun(taskName, taskRow, startedAt)
    const historyId = (
      this.sql
        .exec(
          `INSERT INTO cron_history (task_name, started_at, created_at) VALUES (?, ?, ?) RETURNING id`,
          taskName,
          startedAt,
          startedAt,
        )
        .toArray()[0] as { id: number }
    ).id
    this.trimHistory()
    await this.state.storage.sync()

    const start = Date.now()
    let success = true
    let error: string | undefined

    let thrown: unknown
    try {
      await this.onTask(taskName)
    } catch (e) {
      success = false
      thrown = e
      error = e instanceof Error ? e.message : String(e)
    }

    const durationMs = Date.now() - start
    const completedAt = new Date().toISOString()

    // One line per run, so `deepspace logs --search cron` finds every run by
    // task name. Workers Logs renders an Error object passed to console.* as
    // its stack frames only — the message never arrives (verified against
    // production rows, 2026-08-18) — so the whole story rides in ONE string:
    // loggableError renders message-first with frames and the bounded cause
    // chain (where workerd's `TypeError: fetch failed` hides its reason),
    // capped at the reader's budget.
    if (success) {
      console.log(`[cron] ${taskName} ok ${durationMs}ms`)
    } else {
      console.error(`[cron] ${taskName} failed ${durationMs}ms: ${loggableError(thrown)}`)
    }

    // Close the run's history row
    this.sql.exec(
      `UPDATE cron_history SET completed_at = ?, success = ?, duration_ms = ?, error = ? WHERE id = ?`,
      completedAt,
      success ? 1 : 0,
      durationMs,
      error ?? null,
      historyId,
    )

    this.recordRun(taskName, taskRow, completedAt)

    // Broadcast update to monitors
    this.broadcastStatus()
    return { taskName, startedAt, completedAt, success, durationMs, error }
  }

  /** Set `last_run_at` to `at` and `next_run_at` to the task's next slot after it. */
  private recordRun(taskName: string, taskRow: TaskSchedule, at: string): void {
    this.sql.exec(
      `UPDATE cron_tasks SET last_run_at = ?, next_run_at = ? WHERE name = ?`,
      at,
      computeNextRunAt(taskRow, new Date(at)),
      taskName,
    )
  }

  /** Close runs opened at or before `startedBy` that never finished, as failed. */
  private closeInterruptedRuns(startedBy: number): void {
    const closed = this.sql
      .exec(
        `UPDATE cron_history SET completed_at = ?, error = ?
         WHERE completed_at IS NULL AND started_at <= ? RETURNING task_name`,
        new Date().toISOString(),
        'interrupted (the run never finished)',
        new Date(startedBy).toISOString(),
      )
      .toArray() as { task_name: string }[]
    for (const run of closed) console.error(`[cron] ${run.task_name} interrupted`)
  }

  /** Keep the last 500 history rows. */
  private trimHistory(): void {
    this.sql.exec(
      `DELETE FROM cron_history WHERE id NOT IN (SELECT id FROM cron_history ORDER BY id DESC LIMIT 500)`,
    )
  }

  // ==========================================================================
  // Scheduling
  // ==========================================================================

  private scheduleNextAlarm(): void {
    const { next } = this.sql
      .exec(`SELECT MIN(next_run_at) AS next FROM cron_tasks WHERE paused = 0`)
      .toArray()[0] as { next: string | null }
    if (next) this.state.storage.setAlarm(Math.max(Date.parse(next), Date.now() + 1000)) // At least 1s from now
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private getTaskStates(): Record<string, unknown>[] {
    return this.sql
      .exec(`SELECT * FROM cron_tasks`)
      .toArray()
      .map((row) => {
        const r = row as Record<string, unknown>
        return {
          name: r.name,
          intervalMinutes: r.interval_minutes,
          schedule: r.schedule,
          timezone: r.timezone,
          paused: r.paused === 1,
          lastRunAt: r.last_run_at,
          nextRunAt: r.next_run_at,
        }
      })
  }

  private getRecentHistory(limit: number): CronExecution[] {
    return this.sql
      .exec(
        `SELECT * FROM cron_history WHERE completed_at IS NOT NULL ORDER BY id DESC LIMIT ?`,
        limit,
      )
      .toArray()
      .map((row) => {
        const r = row as Record<string, unknown>
        return {
          taskName: r.task_name as string,
          startedAt: r.started_at as string,
          completedAt: r.completed_at as string | null,
          success: r.success === 1,
          durationMs: r.duration_ms as number,
          error: r.error as string | undefined,
        }
      })
  }

  private broadcastStatus(): void {
    this.broadcast({
      type: MSG.CRON_STATUS,
      payload: {
        tasks: this.getTaskStates(),
        recentHistory: this.getRecentHistory(10),
      },
    })
  }

  /**
   * Receipt for a mutation frame, addressed only to its sender. Receipts
   * are opt-in by correlation id: frames without a `requestId` keep the
   * fire-and-forget contract, so the (untyped) `requestId` from the wire
   * is the single gate here rather than a check at every call site.
   * Frames go through the shared `serverBuild` constructors so the wire
   * shape is enforced by the protocol types, not re-spelled here.
   */
  private ackMutation(
    ws: WebSocket,
    requestId: unknown,
    result:
      | { ok: true; taskName: string }
      | {
          ok: false
          taskName?: string
          reason: 'read_only' | 'unknown_task' | 'failed'
          error?: string
        },
  ): void {
    if (typeof requestId !== 'string') return
    this.sendTo(
      ws,
      result.ok
        ? serverBuild.cronAckSuccess(requestId, result.taskName)
        : serverBuild.cronAckFailure(requestId, result.reason, result.error, result.taskName),
    )
  }

  // ==========================================================================
  // Lifecycle Hook (subclass implements)
  // ==========================================================================

  /**
   * Execute a scheduled task by name.
   * Called both by the alarm scheduler and manual trigger.
   */
  protected abstract onTask(taskName: string): void | Promise<void>
}

/** Rooms this isolate has already woken — the wake is idempotent, so once is enough. */
const armedCronRooms = new Set<string>()

/**
 * Wake the app's CronRoom so its alarm is armed.
 *
 * A Durable Object does not exist until something fetches it, and CronRoom
 * arms its alarm inside that first fetch — so a deployed schedule that no
 * client has opened yet runs nothing, and nothing reports it. The app worker
 * calls this from its request path (once per isolate is enough); the first
 * request the worker handles after a deploy then arms the schedule. A no-op
 * when the app declares no tasks. The wake runs under `ctx.waitUntil`, so it
 * never delays the response.
 */
export function armCronRoom(
  // Structural on purpose: Hono's `c.executionCtx` and workers-types'
  // `ExecutionContext` disagree on members the wake never uses.
  ctx: { waitUntil(promise: Promise<unknown>): void },
  namespace: DurableObjectNamespace,
  roomId: string,
  tasks: readonly CronTask[],
): void {
  if (tasks.length === 0 || armedCronRooms.has(roomId)) return
  armedCronRooms.add(roomId)
  ctx.waitUntil(
    namespace
      .get(namespace.idFromName(roomId))
      .fetch(`https://internal${CRON_TASKS_INTERNAL_PATH}`)
      .then((response) => {
        // `fetch` resolves for HTTP failures. Only a successful internal route
        // proves initialization ran far enough to arm the room.
        if (!response.ok) armedCronRooms.delete(roomId)
        return response
      })
      // A transport failure is not "armed" either: let the next request retry.
      .catch(() => {
        armedCronRooms.delete(roomId)
      }),
  )
}

/**
 * Compute the next ISO timestamp the given task should run at, using
 * `from` as the reference moment.
 */
function computeNextRunAt(task: TaskSchedule, from: Date): string | null {
  if (task.interval_minutes) {
    return new Date(from.getTime() + task.interval_minutes * 60 * 1000).toISOString()
  }
  if (task.schedule && task.timezone) {
    const next = nextCronFire(task.schedule, task.timezone, from)
    return next ? next.toISOString() : null
  }
  return null
}
