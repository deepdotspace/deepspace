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
import { MSG } from '../../shared/protocol/constants'
import { ROLES } from '../../shared/roles'

// ============================================================================
// Types
// ============================================================================

export interface CronTask {
  name: string
  /** Interval in minutes (interval mode) — mutually exclusive with `schedule`. */
  intervalMinutes?: number
  /** 5-field cron expression (cron mode) — requires `timezone`. */
  schedule?: string
  /** IANA timezone string (e.g. "America/New_York"). Required with `schedule`. */
  timezone?: string
  /** Whether the task starts paused. */
  paused?: boolean
}

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

interface CronAttachment extends UserAttachment {
  /** True for member/admin roles; false for viewers and unauthenticated anon. */
  canWrite: boolean
}

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

  constructor(
    state: DurableObjectState,
    env: unknown,
    config: CronRoomConfig
  ) {
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

    // Sync configured tasks. Insert new ones; refresh schedule/interval/timezone
    // on existing ones (so editing src/cron.ts and re-deploying picks up the
    // change without a manual reset). Preserve last_run_at / paused.
    for (const task of this.tasks) {
      const existing = this.sql.exec(
        `SELECT name FROM cron_tasks WHERE name = ?`, task.name
      ).toArray()
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
        this.sql.exec(
          `UPDATE cron_tasks
             SET interval_minutes = ?, schedule = ?, timezone = ?
           WHERE name = ?`,
          task.intervalMinutes ?? null,
          task.schedule ?? null,
          task.timezone ?? null,
          task.name,
        )
      }
    }

    // Remove tasks no longer in config
    const configNames = new Set(this.tasks.map(t => t.name))
    const dbTasks = this.sql.exec(`SELECT name FROM cron_tasks`).toArray()
    for (const row of dbTasks) {
      if (!configNames.has((row as { name: string }).name)) {
        this.sql.exec(`DELETE FROM cron_tasks WHERE name = ?`, (row as { name: string }).name)
      }
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
    message: { type: string; [key: string]: unknown }
  ): Promise<void> {
    this.ensureInitialized()
    const { type, payload } = message as { type: string; payload: Record<string, unknown> }

    if (CRON_WRITE_TYPES.has(type) && !(user as CronAttachment).canWrite) {
      this.sendTo(ws, {
        type: MSG.ERROR,
        payload: { error: 'Write access denied: viewer role cannot modify cron tasks' },
      })
      return
    }

    switch (type) {
      case MSG.CRON_TRIGGER: {
        const taskName = payload.taskName as string
        if (!taskName) {
          this.sendTo(ws, { type: MSG.ERROR, payload: { error: 'Missing taskName' } })
          return
        }
        await this.executeTask(taskName)
        break
      }

      case MSG.CRON_PAUSE: {
        const taskName = payload.taskName as string
        this.sql.exec(`UPDATE cron_tasks SET paused = 1 WHERE name = ?`, taskName)
        this.broadcastStatus()
        break
      }

      case MSG.CRON_RESUME: {
        const taskName = payload.taskName as string
        this.sql.exec(`UPDATE cron_tasks SET paused = 0 WHERE name = ?`, taskName)
        this.scheduleNextAlarm()
        this.broadcastStatus()
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
        this.sendTo(ws, { type: MSG.ERROR, payload: { error: `Unknown cron message type: ${type}` } })
    }
  }

  protected async onAlarm(): Promise<void> {
    this.ensureInitialized()
    const now = new Date()

    // Find all tasks due to run
    const tasks = this.sql.exec(
      `SELECT * FROM cron_tasks WHERE paused = 0 AND (next_run_at IS NULL OR next_run_at <= ?)`,
      now.toISOString()
    ).toArray()

    for (const row of tasks) {
      const task = row as { name: string; interval_minutes: number | null; schedule: string | null; timezone: string | null }
      await this.executeTask(task.name)
    }

    this.scheduleNextAlarm()
  }

  // ==========================================================================
  // Task Execution
  // ==========================================================================

  private async executeTask(taskName: string): Promise<void> {
    const startedAt = new Date().toISOString()
    const start = Date.now()
    let success = true
    let error: string | undefined

    try {
      await this.onTask(taskName)
    } catch (e) {
      success = false
      error = e instanceof Error ? e.message : String(e)
      console.error(`[CronRoom] Task "${taskName}" failed:`, e)
    }

    const durationMs = Date.now() - start
    const completedAt = new Date().toISOString()

    // Record execution
    this.sql.exec(
      `INSERT INTO cron_history (task_name, started_at, completed_at, success, duration_ms, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      taskName, startedAt, completedAt, success ? 1 : 0, durationMs, error ?? null, completedAt,
    )

    // Update last_run_at and compute next_run_at
    const taskRow = this.sql.exec(
      `SELECT interval_minutes, schedule, timezone FROM cron_tasks WHERE name = ?`, taskName
    ).toArray()[0] as { interval_minutes: number | null; schedule: string | null; timezone: string | null } | undefined

    if (taskRow) {
      const nextRunAt = computeNextRunAt(taskRow, new Date(completedAt))
      this.sql.exec(
        `UPDATE cron_tasks SET last_run_at = ?, next_run_at = ? WHERE name = ?`,
        completedAt, nextRunAt, taskName,
      )
    }

    // Trim history to last 500 entries
    this.sql.exec(`DELETE FROM cron_history WHERE id NOT IN (SELECT id FROM cron_history ORDER BY id DESC LIMIT 500)`)

    // Broadcast update to monitors
    this.broadcastStatus()
  }

  // ==========================================================================
  // Scheduling
  // ==========================================================================

  private scheduleNextAlarm(): void {
    const now = Date.now()
    let earliestMs = Infinity

    const tasks = this.sql.exec(
      `SELECT interval_minutes, schedule, timezone, next_run_at FROM cron_tasks WHERE paused = 0`
    ).toArray()

    for (const row of tasks) {
      const t = row as {
        interval_minutes: number | null
        schedule: string | null
        timezone: string | null
        next_run_at: string | null
      }
      let nextMs: number | null = null
      if (t.next_run_at) {
        nextMs = new Date(t.next_run_at).getTime()
      } else if (t.interval_minutes) {
        // Cold-start interval task — run on the next alarm.
        nextMs = now
      } else if (t.schedule && t.timezone) {
        // Cold-start cron task — find the next minute boundary that matches.
        const next = nextCronFire(t.schedule, t.timezone, new Date(now))
        if (next) nextMs = next.getTime()
      }
      if (nextMs != null && nextMs < earliestMs) {
        earliestMs = nextMs
      }
    }

    if (earliestMs < Infinity) {
      const alarmTime = Math.max(earliestMs, now + 1000) // At least 1s from now
      this.state.storage.setAlarm(alarmTime)
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private getTaskStates(): Record<string, unknown>[] {
    return this.sql.exec(`SELECT * FROM cron_tasks`).toArray().map(row => {
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
    return this.sql.exec(
      `SELECT * FROM cron_history ORDER BY id DESC LIMIT ?`, limit
    ).toArray().map(row => {
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

  // ==========================================================================
  // Lifecycle Hook (subclass implements)
  // ==========================================================================

  /**
   * Execute a scheduled task by name.
   * Called both by the alarm scheduler and manual trigger.
   */
  protected abstract onTask(taskName: string): void | Promise<void>
}

// ============================================================================
// Cron expression evaluation
// ============================================================================

const TASK_NAME_RE = /^[a-z0-9-]+$/

/**
 * Validate a single task config. Throws on bad input so a misconfigured
 * deploy fails loudly at construction time rather than silently running
 * the wrong schedule.
 */
export function validateTask(task: CronTask): CronTask {
  if (!task.name || typeof task.name !== 'string') {
    throw new Error(`CronTask.name is required`)
  }
  if (task.name.length > 64 || !TASK_NAME_RE.test(task.name)) {
    throw new Error(
      `CronTask.name "${task.name}" must be lowercase alphanumeric with hyphens, 1-64 chars`,
    )
  }
  const hasInterval = task.intervalMinutes != null
  const hasSchedule = task.schedule != null
  const hasTimezone = task.timezone != null
  if (hasInterval && (hasSchedule || hasTimezone)) {
    throw new Error(
      `CronTask "${task.name}" cannot mix intervalMinutes with schedule/timezone`,
    )
  }
  if (!hasInterval && !(hasSchedule && hasTimezone)) {
    throw new Error(
      `CronTask "${task.name}" must declare either intervalMinutes or schedule+timezone`,
    )
  }
  if (hasInterval) {
    if (!Number.isInteger(task.intervalMinutes) || task.intervalMinutes! < 1 || task.intervalMinutes! > 10080) {
      throw new Error(
        `CronTask "${task.name}" intervalMinutes must be an integer 1..10080`,
      )
    }
  }
  if (hasSchedule) {
    // Throw on parse failure
    parseCronExpression(task.schedule!)
    if (typeof task.timezone !== 'string' || task.timezone.length === 0) {
      throw new Error(`CronTask "${task.name}" timezone must be a non-empty IANA string`)
    }
    // Validate timezone by attempting to format with it.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: task.timezone })
    } catch {
      throw new Error(`CronTask "${task.name}" timezone "${task.timezone}" is not a valid IANA timezone`)
    }
  }
  return task
}

interface ParsedCron {
  minute: Set<number>
  hour: Set<number>
  dayOfMonth: Set<number>
  month: Set<number>
  dayOfWeek: Set<number>
}

/**
 * Parse a 5-field cron expression. Supports:
 *   *           — all values in range
 *   N           — literal
 *   N-M         — range
 *   N-M/S       — range with step
 *   * /S        — every S
 *   N,M,...     — list
 *
 * Throws on malformed input — caller should treat that as a hard config error.
 */
export function parseCronExpression(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`Cron expression must have exactly 5 fields, got ${fields.length}: "${expression}"`)
  }
  const [cMin, cHour, cDom, cMonth, cDow] = fields
  return {
    minute: parseField(cMin, 0, 59, 'minute'),
    hour: parseField(cHour, 0, 23, 'hour'),
    dayOfMonth: parseField(cDom, 1, 31, 'day-of-month'),
    month: parseField(cMonth, 1, 12, 'month'),
    dayOfWeek: parseField(cDow, 0, 6, 'day-of-week'),
  }
}

function parseField(field: string, min: number, max: number, label: string): Set<number> {
  const result = new Set<number>()

  for (const part of field.split(',')) {
    const trimmed = part.trim()

    if (trimmed === '*') {
      for (let i = min; i <= max; i++) result.add(i)
      continue
    }

    // */step
    const allStep = trimmed.match(/^\*\/(\d+)$/)
    if (allStep) {
      const step = parseInt(allStep[1], 10)
      if (step <= 0) throw new Error(`Cron ${label} step must be positive: "${trimmed}"`)
      for (let i = min; i <= max; i += step) result.add(i)
      continue
    }

    // N-M or N-M/S
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10)
      const end = parseInt(rangeMatch[2], 10)
      const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1
      if (start < min || end > max || start > end || step <= 0) {
        throw new Error(`Cron ${label} range out of bounds: "${trimmed}" (${min}..${max})`)
      }
      for (let i = start; i <= end; i += step) result.add(i)
      continue
    }

    // literal
    const num = parseInt(trimmed, 10)
    if (isNaN(num) || num < min || num > max || String(num) !== trimmed) {
      throw new Error(`Cron ${label} value invalid: "${trimmed}" (${min}..${max})`)
    }
    result.add(num)
  }

  if (result.size === 0) {
    throw new Error(`Cron ${label} field "${field}" produced no valid values`)
  }
  return result
}

/**
 * Compute the next ISO timestamp the given task should run at, using
 * `from` as the reference moment.
 */
function computeNextRunAt(
  task: { interval_minutes: number | null; schedule: string | null; timezone: string | null },
  from: Date,
): string | null {
  if (task.interval_minutes) {
    return new Date(from.getTime() + task.interval_minutes * 60 * 1000).toISOString()
  }
  if (task.schedule && task.timezone) {
    const next = nextCronFire(task.schedule, task.timezone, from)
    return next ? next.toISOString() : null
  }
  return null
}

/**
 * Find the next UTC instant after `from` whose wall-clock time in
 * `timezone` matches `expression`. Walks forward minute-by-minute up to
 * a year — matches Miyagi's bound and any task that wouldn't fire in a
 * year is almost certainly misconfigured.
 *
 * DST is handled implicitly: each candidate minute is shifted via
 * `Intl.DateTimeFormat` to the target timezone before comparison, so
 * "0 2 * * *" (2 AM daily) skips the missing 2 AM on spring-forward day
 * and fires once on the duplicate 2 AM in fall-back.
 */
export function nextCronFire(expression: string, timezone: string, from: Date): Date | null {
  const parsed = parseCronExpression(expression)
  // Start at the next minute boundary.
  const start = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000)
  const limit = new Date(start.getTime() + 366 * 24 * 60 * 60_000)
  for (let t = start.getTime(); t < limit.getTime(); t += 60_000) {
    const candidate = new Date(t)
    if (cronMatches(parsed, timezone, candidate)) {
      return candidate
    }
  }
  return null
}

function cronMatches(parsed: ParsedCron, timezone: string, date: Date): boolean {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  })
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(p => [p.type, p.value]),
  )
  const minute = parseInt(parts.minute, 10)
  const hour = parseInt(parts.hour, 10) % 24
  const dayOfMonth = parseInt(parts.day, 10)
  const month = parseInt(parts.month, 10)
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const dayOfWeek = weekdayMap[parts.weekday] ?? 0
  return (
    parsed.minute.has(minute) &&
    parsed.hour.has(hour) &&
    parsed.dayOfMonth.has(dayOfMonth) &&
    parsed.month.has(month) &&
    parsed.dayOfWeek.has(dayOfWeek)
  )
}
