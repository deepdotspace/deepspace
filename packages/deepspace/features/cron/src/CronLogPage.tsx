/**
 * Cron Log Page
 *
 * Subscribes to the app's CronRoom via `useCronMonitor` and renders live
 * task state + execution history. The DO is keyed by `app:${APP_NAME}` so
 * a single shared CronRoom DO instance backs the whole app — same pattern
 * as RecordRoom.
 *
 * Used both as a UI surface for verifying that scheduled tasks are firing
 * in production, and as the data source for the cron e2e spec at
 * tests/feature-tests/tests/cron.spec.ts.
 */

import { useCronMonitor } from 'deepspace'
import { SCOPE_ID } from '../constants'

export default function CronLogPage() {
  const { tasks, history, connected } = useCronMonitor(SCOPE_ID)

  // Newest first.
  const sorted = [...history].sort((a, b) => {
    return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  })

  return (
    <div data-testid="cron-log-page" style={{ padding: 24 }}>
      <h1>Cron Log</h1>
      <p>
        Each row is one tick of a scheduled task fired by the AppCronRoom DO.
        Heartbeat ticks every minute once the DO alarm picks up the registered
        config.
      </p>

      <div data-testid="cron-log-status" style={{ marginBottom: 12 }}>
        Connection: {connected ? 'live' : 'connecting…'}
      </div>

      <h2>Tasks</h2>
      <table data-testid="cron-tasks" style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)', padding: 8 }}>Name</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)', padding: 8 }}>Schedule</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)', padding: 8 }}>Last run</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)', padding: 8 }}>Next run</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.name} data-testid="cron-task-row" data-task={task.name}>
              <td style={{ padding: 8 }}>{task.name}</td>
              <td style={{ padding: 8 }}>
                {task.schedule
                  ? `${task.schedule} (${task.timezone ?? 'UTC'})`
                  : `every ${task.intervalMinutes ?? '?'} min`}
              </td>
              <td style={{ padding: 8 }}>{task.lastRunAt ?? '—'}</td>
              <td style={{ padding: 8 }}>{task.nextRunAt ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 24 }}>History</h2>
      <div data-testid="cron-log-count">{sorted.length} entries</div>

      <table style={{ marginTop: 16, borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)', padding: 8 }}>Task</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)', padding: 8 }}>Started (UTC)</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)', padding: 8 }}>Duration</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)', padding: 8 }}>Outcome</th>
          </tr>
        </thead>
        <tbody data-testid="cron-log-rows">
          {sorted.map((entry, idx) => (
            <tr
              key={`${entry.taskName}-${entry.startedAt}-${idx}`}
              data-testid="cron-log-row"
              data-task={entry.taskName}
              data-success={entry.success ? '1' : '0'}
            >
              <td style={{ padding: 8 }}>{entry.taskName}</td>
              <td style={{ padding: 8 }}>{entry.startedAt}</td>
              <td style={{ padding: 8 }}>{entry.durationMs} ms</td>
              <td style={{ padding: 8 }}>{entry.success ? 'ok' : `error: ${entry.error ?? '?'}`}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {sorted.length === 0 && connected && (
        <p data-testid="cron-log-empty" style={{ marginTop: 24, opacity: 0.6 }}>
          No cron ticks recorded yet. The first one should appear within ~90s of deploy.
        </p>
      )}
    </div>
  )
}
