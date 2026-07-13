/**
 * JobRoom unit tests — exercises the end-to-end lifecycle of a job
 * (enqueue → run → succeeded/failed/canceled) against a better-sqlite3
 * shim, the same harness style cron-room.test.ts uses.
 *
 * The tests target behaviors that are easy to regress and hard to catch
 * in integration:
 *
 *   1. Successful run: enqueue → drain → succeeded with the captured result.
 *   2. Failure with retries: a handler that throws once is retried; only
 *      after `maxAttempts` is the row marked failed.
 *   3. Cancellation: a JOB_CANCEL frame in flight aborts the in-isolate
 *      AbortSignal and marks the row canceled even if the handler ignores it.
 *   4. ctx.continue: a handler that yields once resumes with the previous
 *      checkpoint as `job.resumeFrom`.
 *   5. Crash recovery: a `running` row older than the alarm wall-time is
 *      either retried or permanently failed when the room re-initializes.
 *
 * The handler closures inside each test are the public contract the
 * SDK ships — if any of these break, an app's job handler breaks too.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { JobRoom, type Job, type JobContext } from '../job-room'
import { MSG } from '../../../shared/protocol/constants'
import type { ServerMessage } from '../../../shared/protocol/messages'

/** The discriminated `job.update` variant of the server-message union. */
type JobUpdateMessage = Extract<ServerMessage, { type: typeof MSG.JOB_UPDATE }>
/** Read a JOB_UPDATE message's payload with its real (typed) shape. */
function jobPayload(m: ServerMessage): JobUpdateMessage['payload'] {
  return (m as JobUpdateMessage).payload
}

// BaseRoom's constructor calls `new WebSocketRequestResponsePair(...)`
// which only exists in workerd. Vitest runs under node — stub it.
;(globalThis as { WebSocketRequestResponsePair?: unknown }).WebSocketRequestResponsePair ??=
  class {
    constructor(_req: string, _resp: string) {}
  }

// ---------------------------------------------------------------------------
// SqlStorage shim — same pattern as cron-room.test.ts.
// ---------------------------------------------------------------------------

function makeSql(db: Database.Database): SqlStorage {
  return {
    exec(query: string, ...bindings: unknown[]): { toArray: () => unknown[] } {
      const trimmed = query.trim()
      const isSelect = /^(SELECT|PRAGMA)/i.test(trimmed)

      if (bindings.length === 0 && !isSelect) {
        db.exec(query)
        return { toArray: () => [] }
      }

      const stmt = db.prepare(query)
      if (isSelect) {
        const rows = stmt.all(...bindings)
        return { toArray: () => rows }
      }
      stmt.run(...bindings)
      return { toArray: () => [] }
    },
    get databaseSize(): number {
      return 0
    },
    Cursor: undefined as unknown as SqlStorage['Cursor'],
    Statement: undefined as unknown as SqlStorage['Statement'],
  } as unknown as SqlStorage
}

function makeState(db: Database.Database): {
  state: DurableObjectState
  alarms: number[]
} {
  const alarms: number[] = []
  const state = {
    storage: {
      sql: makeSql(db),
      setAlarm(time: number) {
        alarms.push(time)
      },
    },
    setWebSocketAutoResponse() {},
    getWebSockets(): WebSocket[] {
      return []
    },
    acceptWebSocket() {},
  } as unknown as DurableObjectState
  return { state, alarms }
}

// ---------------------------------------------------------------------------
// Test-driven concrete subclass. Captures every broadcast and exposes the
// protected handler + alarm + onMessage so tests can drive them directly.
// ---------------------------------------------------------------------------

type Handler = (job: Job, ctx: JobContext) => Promise<unknown> | unknown

class TestJobRoom extends JobRoom {
  public broadcasts: ServerMessage[] = []
  /** Per-socket sends (sendTo). Captured so tests can assert that the
   * enqueue ack with `requestId` is delivered only to the originator. */
  public directSends: ServerMessage[] = []
  public handler: Handler = () => undefined

  protected async onJob(job: Job, ctx: JobContext) {
    return await this.handler(job, ctx)
  }

  protected broadcast(message: ServerMessage): void {
    this.broadcasts.push(message)
  }

  protected sendTo(_ws: WebSocket, message: ServerMessage): void {
    this.directSends.push(message)
  }

  public init(): void {
    ;(this as unknown as { ensureInitialized(): void }).ensureInitialized()
  }

  public runAlarm(): Promise<void> {
    return (this as unknown as { onAlarm(): Promise<void> }).onAlarm()
  }

  public dispatch(message: { type: string; payload: Record<string, unknown> }): Promise<void> {
    const ws = {} as WebSocket
    const user = { userId: 'tester', userName: 't', userEmail: '' }
    return Promise.resolve(
      (this as unknown as { onMessage(ws: WebSocket, user: unknown, message: unknown): void | Promise<void> }).onMessage(ws, user, message),
    )
  }
}

function makeRoom(db: Database.Database, handler: Handler = () => undefined): TestJobRoom {
  const { state } = makeState(db)
  // `retryBackoffMs: 0` makes the next alarm pick up a re-queued job
  // immediately. In production the default is 1000ms.
  const room = new TestJobRoom(state, {}, { retryBackoffMs: 0 })
  room.handler = handler
  room.init()
  return room
}

// ---------------------------------------------------------------------------
// Lifecycle tests
// ---------------------------------------------------------------------------

describe('JobRoom — success path', () => {
  it('enqueues, runs onJob, and marks the row succeeded with the result', async () => {
    const db = new Database(':memory:')
    const room = makeRoom(db, async (job) => {
      // Echo the payload back as the result so the test can assert round-trip.
      return { echoed: (job.payload as { input: string }).input }
    })

    await room.dispatch({
      type: MSG.JOB_ENQUEUE,
      payload: { requestId: 'req-1', type: 'echo', payload: { input: 'hi' } },
    })

    // Before draining, the row is queued. The enqueue path scopes the
    // requestId-echoing ack to the originator (via sendTo) and broadcasts
    // a copy without the requestId to all other subscribers.
    const queued = db.prepare(`SELECT status FROM jobs`).get() as { status: string }
    expect(queued.status).toBe('queued')

    const enqueueAck = room.directSends.find(
      (m) => m.type === MSG.JOB_UPDATE && jobPayload(m).kind === 'enqueued',
    )
    expect(enqueueAck).toBeDefined()
    expect(jobPayload(enqueueAck!).requestId).toBe('req-1')

    const enqueueBroadcast = room.broadcasts.find(
      (m) => m.type === MSG.JOB_UPDATE && jobPayload(m).kind === 'enqueued',
    )
    expect(enqueueBroadcast).toBeDefined()
    expect(jobPayload(enqueueBroadcast!).requestId).toBeUndefined()

    await room.runAlarm()

    const final = db
      .prepare(`SELECT status, result, error, attempts FROM jobs`)
      .get() as { status: string; result: string; error: string | null; attempts: number }
    expect(final.status).toBe('succeeded')
    expect(JSON.parse(final.result)).toEqual({ echoed: 'hi' })
    expect(final.error).toBeNull()
    expect(final.attempts).toBe(1)

    const succeeded = room.broadcasts.find(
      (m) => m.type === MSG.JOB_UPDATE && jobPayload(m).kind === 'succeeded',
    )
    expect(succeeded).toBeDefined()
  })
})

describe('JobRoom — failure + retry', () => {
  // These tests deliberately throw from the handler; JobRoom logs each failed
  // attempt via console.error by design. Silence it so the intentional errors
  // don't masquerade as test failures in the output.
  let errSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errSpy.mockRestore()
  })

  // Each retry consumes its own alarm tick (drainDueJobs freezes the
  // cutoff at the start of the drain so re-queued rows fall out of the
  // current tick and pick up on the next alarm). Tests fire the alarm
  // once per attempt to mirror that.
  it('retries a flaky job and eventually succeeds within maxAttempts', async () => {
    const db = new Database(':memory:')
    let calls = 0
    const room = makeRoom(db, async () => {
      calls++
      if (calls < 3) throw new Error(`boom-${calls}`)
      return 'finally ok'
    })

    await room.dispatch({
      type: MSG.JOB_ENQUEUE,
      payload: { requestId: 'r', type: 'flaky', maxAttempts: 5 },
    })
    await room.runAlarm() // attempt 1 → fail
    await room.runAlarm() // attempt 2 → fail
    await room.runAlarm() // attempt 3 → succeed

    const final = db.prepare(`SELECT status, attempts, result FROM jobs`).get() as Record<string, unknown>
    expect(final.status).toBe('succeeded')
    expect(final.attempts).toBe(3)
    expect(JSON.parse(final.result as string)).toBe('finally ok')
    expect(calls).toBe(3)

    // Each failed attempt should have emitted a 'retried' broadcast
    // before the eventual success.
    const retried = room.broadcasts.filter(
      (m) => m.type === MSG.JOB_UPDATE && jobPayload(m).kind === 'retried',
    )
    expect(retried).toHaveLength(2)
  })

  it('marks the row failed once attempts >= maxAttempts', async () => {
    const db = new Database(':memory:')
    let calls = 0
    const room = makeRoom(db, async () => {
      calls++
      throw new Error('never works')
    })

    await room.dispatch({
      type: MSG.JOB_ENQUEUE,
      payload: { requestId: 'r', type: 'broken', maxAttempts: 2 },
    })
    await room.runAlarm() // attempt 1 → retry
    await room.runAlarm() // attempt 2 → fail permanently

    const final = db.prepare(`SELECT status, attempts, error FROM jobs`).get() as Record<string, unknown>
    expect(final.status).toBe('failed')
    expect(final.attempts).toBe(2)
    expect(final.error).toBe('never works')
    expect(calls).toBe(2)
  })
})

describe('JobRoom — cancellation', () => {
  it('aborts an in-flight handler when JOB_CANCEL arrives', async () => {
    const db = new Database(':memory:')
    let abortObserved = false
    let jobIdInsideHandler = ''
    const room = makeRoom(db, async (job, ctx) => {
      jobIdInsideHandler = job.id
      // Simulate the handler "racing" the cancel: it observes the signal
      // mid-flight as it would in real code that loops on `signal.aborted`.
      // We pre-arrange the cancel via dispatch BEFORE awaiting so the
      // controller is aborted by the time we look.
      await room.dispatch({ type: MSG.JOB_CANCEL, payload: { jobId: job.id } })
      abortObserved = ctx.signal.aborted
      return 'this return value should be discarded'
    })

    await room.dispatch({
      type: MSG.JOB_ENQUEUE,
      payload: { requestId: 'r', type: 'long' },
    })
    await room.runAlarm()

    expect(jobIdInsideHandler).not.toBe('')
    expect(abortObserved).toBe(true)
    const final = db.prepare(`SELECT status FROM jobs`).get() as { status: string }
    expect(final.status).toBe('canceled')

    const canceled = room.broadcasts.find(
      (m) => m.type === MSG.JOB_UPDATE && jobPayload(m).kind === 'canceled',
    )
    expect(canceled).toBeDefined()
  })
})

describe('JobRoom — ctx.continue checkpoint', () => {
  it('passes the previous checkpoint as job.resumeFrom on the next tick', async () => {
    const db = new Database(':memory:')
    const seenResumeFrom: unknown[] = []
    const room = makeRoom(db, async (job, ctx) => {
      seenResumeFrom.push(job.resumeFrom)
      const previous = (job.resumeFrom as { i?: number } | undefined)?.i ?? 0
      if (previous < 2) {
        ctx.continue({ i: previous + 1 })
        return
      }
      return { done: previous }
    })

    await room.dispatch({
      type: MSG.JOB_ENQUEUE,
      payload: { requestId: 'r', type: 'multi' },
    })

    await room.runAlarm() // round 1: continue({i:1})
    await room.runAlarm() // round 2: continue({i:2})
    await room.runAlarm() // round 3: returns done

    expect(seenResumeFrom).toEqual([undefined, { i: 1 }, { i: 2 }])
    const final = db.prepare(`SELECT status, result FROM jobs`).get() as Record<string, unknown>
    expect(final.status).toBe('succeeded')
    expect(JSON.parse(final.result as string)).toEqual({ done: 2 })
  })
})

describe('JobRoom — crash recovery', () => {
  it('retries a stale `running` row that has retry budget left', async () => {
    const db = new Database(':memory:')

    // Seed the schema by initializing a throwaway room, then plant the
    // state a recycled isolate would have left: status='running' with
    // started_at 30 minutes ago, attempts < maxAttempts.
    new TestJobRoom(makeState(db).state, {}).init()
    const longAgo = new Date(Date.now() - 30 * 60_000).toISOString()
    db.prepare(
      `INSERT INTO jobs (id, type, status, attempts, max_attempts, enqueued_at, started_at)
         VALUES (?, ?, 'running', 1, 3, ?, ?)`,
    ).run('zombie-1', 'orphan', longAgo, longAgo)

    // Fresh room init triggers recoverStuckRunning(); the row should be
    // re-queued and pickable on the next alarm.
    const room = new TestJobRoom(makeState(db).state, {})
    let didRun = false
    room.handler = () => {
      didRun = true
      return 'recovered'
    }
    room.init()

    const recovered = db
      .prepare(`SELECT status, started_at FROM jobs WHERE id = 'zombie-1'`)
      .get() as Record<string, unknown>
    expect(recovered.status).toBe('queued')
    expect(recovered.started_at).toBeNull()

    await room.runAlarm()
    expect(didRun).toBe(true)
    const final = db.prepare(`SELECT status FROM jobs WHERE id = 'zombie-1'`).get() as Record<string, unknown>
    expect(final.status).toBe('succeeded')
  })

  it('permanently fails a stale `running` row that has exhausted attempts', async () => {
    const db = new Database(':memory:')

    new TestJobRoom(makeState(db).state, {}).init()
    const longAgo = new Date(Date.now() - 30 * 60_000).toISOString()
    db.prepare(
      `INSERT INTO jobs (id, type, status, attempts, max_attempts, enqueued_at, started_at)
         VALUES (?, ?, 'running', 3, 3, ?, ?)`,
    ).run('zombie-2', 'orphan', longAgo, longAgo)

    new TestJobRoom(makeState(db).state, {}).init()

    const row = db.prepare(`SELECT status, error FROM jobs WHERE id = 'zombie-2'`).get() as Record<string, unknown>
    expect(row.status).toBe('failed')
    expect(row.error).toMatch(/Isolate recycled|wall time/)
  })
})

describe('JobRoom — progress', () => {
  it('publishes progress updates via JOB_UPDATE broadcasts', async () => {
    const db = new Database(':memory:')
    const room = makeRoom(db, async (_job, ctx) => {
      ctx.progress(0.25, 'quarter')
      ctx.progress(0.75, 'three-quarters')
      return 'done'
    })

    await room.dispatch({
      type: MSG.JOB_ENQUEUE,
      payload: { requestId: 'r', type: 'progressing' },
    })
    await room.runAlarm()

    const progressEvents = room.broadcasts.filter(
      (m) => m.type === MSG.JOB_UPDATE && jobPayload(m).kind === 'progress',
    )
    expect(progressEvents).toHaveLength(2)
    const last = jobPayload(progressEvents[1]).job as Job
    expect(last.progress).toBe(0.75)
    expect(last.progressMessage).toBe('three-quarters')

    // Once the job reaches a terminal state, progress fields are cleared
    // so the persisted row doesn't claim "75% done" on a succeeded job.
    const final = db.prepare(`SELECT status, progress, progress_message FROM jobs`).get() as Record<string, unknown>
    expect(final.status).toBe('succeeded')
    expect(final.progress).toBeNull()
    expect(final.progress_message).toBeNull()
  })
})
