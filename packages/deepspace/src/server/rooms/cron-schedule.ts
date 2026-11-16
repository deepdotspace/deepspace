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

const MINUTE_MS = 60_000
// Feb 29 can be eight years away (2096 to 2104), so search that far.
const SEARCH_MS = 8 * 366 * 24 * 60 * MINUTE_MS
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/**
 * Find the next UTC minute whose wall-clock fields match in `timezone`, or
 * null when the schedule has no such minute in the next eight years (for
 * example `0 0 30 2 *`). Stretches that cannot match are skipped: a day that
 * does not match jumps to 22:00 local, and a non-matching hour moves a quarter
 * hour at a time. Clocks change only on quarter hours (Chatham at :45) and by
 * at most two hours (Troll), so no skip passes over a match.
 */
export function nextCronFire(expression: string, timezone: string, from: Date): Date | null {
  const parsed = parseCronExpression(expression)
  const hasDay = [...parsed.month].some((month) =>
    [...parsed.dayOfMonth].some((day) => day <= DAYS_IN_MONTH[month - 1]),
  )
  if (!hasDay) return null

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  })
  let timestamp = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS
  const limit = timestamp + SEARCH_MS
  while (timestamp < limit) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]),
    )
    const minute = Number.parseInt(parts.minute, 10)
    const hour = Number.parseInt(parts.hour, 10) % 24
    const dayMatches =
      parsed.dayOfMonth.has(Number.parseInt(parts.day, 10)) &&
      parsed.month.has(Number.parseInt(parts.month, 10)) &&
      parsed.dayOfWeek.has(WEEKDAYS[parts.weekday])
    if (!dayMatches && hour < 22) {
      timestamp += ((22 - hour) * 60 - minute) * MINUTE_MS
    } else if (!dayMatches || !parsed.hour.has(hour)) {
      timestamp += (15 - (minute % 15)) * MINUTE_MS
    } else if (parsed.minute.has(minute)) {
      return new Date(timestamp)
    } else {
      timestamp += MINUTE_MS
    }
  }
  return null
}
