/**
 * Cron task definitions for the heartbeat reference feature.
 *
 * AppCronRoom (declared in worker.ts) reads `tasks` at construction time
 * and validates them. The DO alarm fires `runTask(name, env)` on the
 * configured schedule; each fire is recorded in the DO's `cron_history`
 * table and pushed to subscribers over `/ws/cron/:roomId`.
 *
 * The heartbeat task here is the low-cost liveness probe used by both
 * the cron e2e spec and as a quick sanity check after a deploy. To add
 * your own task, append a {name, intervalMinutes} or {name, schedule,
 * timezone} entry to `tasks` and dispatch on `name` inside `runTask`.
 */

import type { CronTask } from 'deepspace/worker'

export const tasks: CronTask[] = [
  { name: 'heartbeat', intervalMinutes: 1 },
]

export async function runTask(_name: string, _env: unknown): Promise<void> {
  // No-op work — the DO records every invocation in cron_history regardless,
  // which is what the e2e spec asserts against. Real apps would dispatch on
  // `_name` here and call into integrations / records via buildCronContext.
}
