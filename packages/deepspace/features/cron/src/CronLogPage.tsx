/**
 * Cron Log Page
 *
 * Subscribes to the app's CronRoom via `useCronMonitor` and renders live
 * task state + execution history with the scaffold's ui primitives and
 * theme tokens. The DO is keyed by `SCOPE_ID` (`app:${APP_ID}`) so a
 * single shared CronRoom DO instance backs the whole app — same pattern
 * as RecordRoom.
 *
 * Used both as a UI surface for verifying that scheduled tasks are firing
 * in production, and as the data source for the cron e2e spec at
 * tests/feature-tests/tests/cron.spec.ts — keep the data-testid and
 * data-* attributes stable.
 */

import { useCronMonitor } from 'deepspace'
import { Badge, EmptyState } from '@/components/ui'
import { SCOPE_ID } from '../constants'

const TH = 'px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground'
const TD = 'px-4 py-3 text-sm'

export default function CronLogPage() {
  const { tasks, history, connected, lastError } = useCronMonitor(SCOPE_ID)

  // Newest first.
  const sorted = [...history].sort((a, b) => {
    return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  })

  return (
    <div data-testid="cron-log-page" className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Cron Log</h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Each row is one tick of a scheduled task fired by the AppCronRoom DO.
            Heartbeat ticks every minute once the DO alarm picks up the registered
            config.
          </p>
        </div>
        <div
          data-testid="cron-log-status"
          className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground"
        >
          Connection:
          <Badge variant={connected ? 'success' : 'secondary'}>
            {connected ? 'live' : 'connecting…'}
          </Badge>
        </div>
      </div>

      {lastError && (
        <p data-testid="cron-log-error" className="mt-2 text-sm text-destructive">
          error: {lastError}
        </p>
      )}

      <h2 className="mt-8 text-lg font-semibold text-foreground">Tasks</h2>
      <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-card/60">
        <table data-testid="cron-tasks" className="w-full min-w-160">
          <thead>
            <tr className="border-b border-border">
              <th className={TH}>Name</th>
              <th className={TH}>Schedule</th>
              <th className={TH}>Last run</th>
              <th className={TH}>Next run</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {tasks.map((task) => (
              <tr key={task.name} data-testid="cron-task-row" data-task={task.name}>
                <td className={`${TD} font-medium text-foreground`}>{task.name}</td>
                <td className={`${TD} text-foreground`}>
                  {task.schedule
                    ? `${task.schedule} (${task.timezone ?? 'UTC'})`
                    : `every ${task.intervalMinutes ?? '?'} min`}
                </td>
                <td className={`${TD} font-mono text-muted-foreground`}>{task.lastRunAt ?? '—'}</td>
                <td className={`${TD} font-mono text-muted-foreground`}>{task.nextRunAt ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-8 flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-semibold text-foreground">History</h2>
        <span data-testid="cron-log-count" className="text-sm text-muted-foreground">
          {sorted.length} entries
        </span>
      </div>
      <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-card/60">
        <table className="w-full min-w-160">
          <thead>
            <tr className="border-b border-border">
              <th className={TH}>Task</th>
              <th className={TH}>Started (UTC)</th>
              <th className={TH}>Duration</th>
              <th className={TH}>Outcome</th>
            </tr>
          </thead>
          <tbody data-testid="cron-log-rows" className="divide-y divide-border/50">
            {sorted.map((entry, idx) => (
              <tr
                key={`${entry.taskName}-${entry.startedAt}-${idx}`}
                data-testid="cron-log-row"
                data-task={entry.taskName}
                data-success={entry.success ? '1' : '0'}
              >
                <td className={`${TD} font-medium text-foreground`}>{entry.taskName}</td>
                <td className={`${TD} font-mono text-muted-foreground`}>{entry.startedAt}</td>
                <td className={`${TD} text-foreground`}>{entry.durationMs} ms</td>
                <td className={TD}>
                  {entry.success ? (
                    <Badge variant="success" size="sm">
                      ok
                    </Badge>
                  ) : (
                    <span className="text-destructive">error: {entry.error ?? '?'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sorted.length === 0 && connected && (
        <EmptyState
          data-testid="cron-log-empty"
          title="No cron ticks recorded yet"
          description="The first one should appear within ~90s of deploy."
        />
      )}
    </div>
  )
}
