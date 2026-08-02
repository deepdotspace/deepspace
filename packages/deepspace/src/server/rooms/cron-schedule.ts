/** Pure validation and evaluation for CronRoom schedules. */

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

const TASK_NAME_RE = /^[a-z0-9-]+$/

/** Reject invalid task configuration before CronRoom mutates storage. */
export function validateTask(task: CronTask): CronTask {
  if (!task.name || typeof task.name !== 'string') {
    throw new Error('CronTask.name is required')
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
    throw new Error(`CronTask "${task.name}" cannot mix intervalMinutes with schedule/timezone`)
  }
  if (!hasInterval && !(hasSchedule && hasTimezone)) {
    throw new Error(
      `CronTask "${task.name}" must declare either intervalMinutes or schedule+timezone`,
    )
  }
  if (
    hasInterval &&
    (!Number.isInteger(task.intervalMinutes) ||
      task.intervalMinutes! < 1 ||
      task.intervalMinutes! > 10080)
  ) {
    throw new Error(`CronTask "${task.name}" intervalMinutes must be an integer 1..10080`)
  }
  if (hasSchedule) {
    parseCronExpression(task.schedule!)
    if (typeof task.timezone !== 'string' || task.timezone.length === 0) {
      throw new Error(`CronTask "${task.name}" timezone must be a non-empty IANA string`)
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: task.timezone })
    } catch {
      throw new Error(
        `CronTask "${task.name}" timezone "${task.timezone}" is not a valid IANA timezone`,
      )
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

/** Parse a 5-field expression with literals, lists, ranges, and steps. */
export function parseCronExpression(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(
      `Cron expression must have exactly 5 fields, got ${fields.length}: "${expression}"`,
    )
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  return {
    minute: parseField(minute, 0, 59, 'minute'),
    hour: parseField(hour, 0, 23, 'hour'),
    dayOfMonth: parseField(dayOfMonth, 1, 31, 'day-of-month'),
    month: parseField(month, 1, 12, 'month'),
    dayOfWeek: parseField(dayOfWeek, 0, 6, 'day-of-week'),
  }
}

function parseField(field: string, min: number, max: number, label: string): Set<number> {
  const result = new Set<number>()

  for (const part of field.split(',')) {
    const value = part.trim()
    if (value === '*') {
      for (let i = min; i <= max; i++) result.add(i)
      continue
    }

    const allStep = value.match(/^\*\/(\d+)$/)
    if (allStep) {
      const step = Number.parseInt(allStep[1], 10)
      if (step <= 0) throw new Error(`Cron ${label} step must be positive: "${value}"`)
      for (let i = min; i <= max; i += step) result.add(i)
      continue
    }

    const range = value.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
    if (range) {
      const start = Number.parseInt(range[1], 10)
      const end = Number.parseInt(range[2], 10)
      const step = range[3] ? Number.parseInt(range[3], 10) : 1
      if (start < min || end > max || start > end || step <= 0) {
        throw new Error(`Cron ${label} range out of bounds: "${value}" (${min}..${max})`)
      }
      for (let i = start; i <= end; i += step) result.add(i)
      continue
    }

    const literal = Number.parseInt(value, 10)
    if (Number.isNaN(literal) || literal < min || literal > max || String(literal) !== value) {
      throw new Error(`Cron ${label} value invalid: "${value}" (${min}..${max})`)
    }
    result.add(literal)
  }

  if (result.size === 0) {
    throw new Error(`Cron ${label} field "${field}" produced no valid values`)
  }
  return result
}

/**
 * Find the next UTC minute whose wall-clock fields match in `timezone`.
 * The one-year bound rejects schedules that are not useful to this room.
 */
export function nextCronFire(expression: string, timezone: string, from: Date): Date | null {
  const parsed = parseCronExpression(expression)
  const start = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000
  const limit = start + 366 * 24 * 60 * 60_000
  for (let timestamp = start; timestamp < limit; timestamp += 60_000) {
    const candidate = new Date(timestamp)
    if (cronMatches(parsed, timezone, candidate)) return candidate
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
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  )
  const minute = Number.parseInt(parts.minute, 10)
  const hour = Number.parseInt(parts.hour, 10) % 24
  const dayOfMonth = Number.parseInt(parts.day, 10)
  const month = Number.parseInt(parts.month, 10)
  const weekday: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }
  const dayOfWeek = weekday[parts.weekday] ?? 0
  return (
    parsed.minute.has(minute) &&
    parsed.hour.has(hour) &&
    parsed.dayOfMonth.has(dayOfMonth) &&
    parsed.month.has(month) &&
    parsed.dayOfWeek.has(dayOfWeek)
  )
}
