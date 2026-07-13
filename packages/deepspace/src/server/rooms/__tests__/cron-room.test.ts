/**
 * CronRoom unit tests — cron-expression parsing, DST-aware next-fire,
 * and the pause→broadcastStatus message-handler chain.
 *
 * The cron-expression and validateTask blocks target the pure helpers,
 * covering the two axes a misconfigured deploy can fail on:
 *
 *   1. The parser refuses bad expressions at construction time, so a
 *      typo in src/cron.ts surfaces as a constructor throw rather than
 *      a silently mis-firing alarm.
 *
 *   2. nextCronFire walks UTC and shifts to the configured IANA zone
 *      via Intl.DateTimeFormat for each candidate, so DST transitions
 *      (spring-forward / fall-back) don't double-fire or skip.
 *
 * The pause-then-status block exercises the WS message handler
 * end-to-end against a better-sqlite3-backed SqlStorage shim (same
 * shim style as collection-table-migration.test.ts). It locks in the
 * contract that `useCronMonitor.pause(taskName)` flips `paused=1` in
 * cron_tasks AND triggers a CRON_STATUS broadcast — without that, the
 * monitor UI would silently fail to update for other connected
 * clients after a pause.
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  parseCronExpression,
  nextCronFire,
  validateTask,
  CronRoom,
  type CronRoomConfig,
} from '../cron-room'
import { MSG } from '../../../shared/protocol/constants'
import { ROLES } from '../../../shared/roles'
import type { UserAttachment } from '../base-room'
import type { ServerMessage } from '../../../shared/protocol/messages'

// BaseRoom's constructor calls `new WebSocketRequestResponsePair('ping', 'pong')`
// which only exists in the workerd runtime. Vitest runs under node, so stub
// the constructor with a no-op class so we can instantiate a CronRoom.
;(globalThis as { WebSocketRequestResponsePair?: unknown }).WebSocketRequestResponsePair ??=
  class { constructor(_req: string, _resp: string) {} }

describe('parseCronExpression', () => {
  it('parses a simple every-minute expression', () => {
    const parsed = parseCronExpression('* * * * *')
    expect(parsed.minute.size).toBe(60)
    expect(parsed.hour.size).toBe(24)
    expect(parsed.dayOfMonth.size).toBe(31)
    expect(parsed.month.size).toBe(12)
    expect(parsed.dayOfWeek.size).toBe(7)
  })

  it('parses ranges, lists, and step expressions', () => {
    const parsed = parseCronExpression('0 9-17 * * 1-5')
    expect(Array.from(parsed.minute)).toEqual([0])
    expect(Array.from(parsed.hour).sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect(Array.from(parsed.dayOfWeek).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('throws on the wrong number of fields', () => {
    expect(() => parseCronExpression('* * * *')).toThrow(/5 fields/)
    expect(() => parseCronExpression('* * * * * *')).toThrow(/5 fields/)
  })

  it('throws on out-of-range literals', () => {
    expect(() => parseCronExpression('60 * * * *')).toThrow(/minute/)
    expect(() => parseCronExpression('* 25 * * *')).toThrow(/hour/)
    expect(() => parseCronExpression('* * 0 * *')).toThrow(/day-of-month/)
  })

  it('throws on non-numeric garbage', () => {
    expect(() => parseCronExpression('foo * * * *')).toThrow()
  })
})

describe('nextCronFire', () => {
  it('finds the next minute boundary that matches', () => {
    // 9 AM UTC weekdays. Reference: Tue 2026-04-28 at 08:50 UTC.
    const from = new Date('2026-04-28T08:50:00Z')
    const next = nextCronFire('0 9 * * 1-5', 'UTC', from)
    expect(next?.toISOString()).toBe('2026-04-28T09:00:00.000Z')
  })

  it('handles DST spring-forward in America/New_York (skips 2 AM)', () => {
    // Spring-forward 2026-03-08: 02:00 EST jumps to 03:00 EDT — 2 AM
    // doesn't exist on the wall clock that day, so a "0 2 * * *" task
    // should fire on the NEXT day at 2 AM EDT instead.
    const from = new Date('2026-03-08T05:00:00Z') // 00:00 EST
    const next = nextCronFire('0 2 * * *', 'America/New_York', from)
    expect(next).not.toBeNull()
    // The next 2 AM EDT after the skip is 2026-03-09 02:00 EDT = 06:00 UTC.
    expect(next?.toISOString()).toBe('2026-03-09T06:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// SqlStorage shim over better-sqlite3 (mirrors collection-table-migration.test)
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

// ---------------------------------------------------------------------------
// Minimal DurableObjectState shim — only the surface CronRoom + BaseRoom
// touch synchronously when no real WebSocket is connected. The room's
// constructor calls setWebSocketAutoResponse; ensureInitialized calls
// storage.setAlarm; broadcast walks getWebSockets (empty list is fine).
// ---------------------------------------------------------------------------

function makeState(db: Database.Database): { state: DurableObjectState; alarms: number[] } {
  const alarms: number[] = []
  const state = {
    storage: {
      sql: makeSql(db),
      setAlarm(time: number) {
        alarms.push(time)
      },
    },
    setWebSocketAutoResponse() {
      // no-op
    },
    getWebSockets(): WebSocket[] {
      return []
    },
    acceptWebSocket() {
      // no-op
    },
  } as unknown as DurableObjectState
  return { state, alarms }
}

// ---------------------------------------------------------------------------
// Concrete CronRoom subclass that:
//   1. exposes the protected onMessage so the test can drive it,
//   2. records every broadcast, since BaseRoom.broadcast iterates the
//      DO's WebSocket list (empty here) — we override it to capture
//      what _would_ have been sent.
// ---------------------------------------------------------------------------

class TestCronRoom extends CronRoom {
  public broadcasts: ServerMessage[] = []
  public sent: ServerMessage[] = []

  protected onTask(): void {
    // unused in this test
  }

  // Override BaseRoom.broadcast — the test runs without real WebSockets,
  // so capture what _would_ have been sent instead of walking an empty list.
  protected broadcast(message: ServerMessage, _exclude?: WebSocket): void {
    this.broadcasts.push(message)
  }

  // BaseRoom.sendTo guards on `ws.readyState === WebSocket.OPEN`, which is
  // never true for our `{} as WebSocket` test stub, so the real sendTo
  // silently drops every message. Override here so assertions can verify
  // that read replies (CRON_TASKS, CRON_HISTORY) and ERROR responses
  // actually reach the caller.
  protected sendTo(_ws: WebSocket, message: ServerMessage): void {
    this.sent.push(message)
  }

  // Force initialization without needing a real WS upgrade.
  public init(): void {
    // ensureInitialized is private — driving it via the public fetch path
    // requires a Request, which is more ceremony than necessary. Reach
    // through the prototype: it's a plain method, not state.
    ;(this as unknown as { ensureInitialized(): void }).ensureInitialized()
  }

  // Public passthrough so the test can call the protected handler.
  // Defaults the connecting user to an admin so existing happy-path tests
  // exercise the success branch without re-stating the role each time;
  // gating tests pass an explicit viewer/anon user to drive the deny path.
  public dispatch(
    message: { type: string; payload: Record<string, unknown> },
    user: UserAttachment = {
      userId: 'test',
      userName: 'test',
      userEmail: '',
      role: ROLES.ADMIN,
      canWrite: true,
    },
  ): Promise<void> {
    const ws = {} as WebSocket
    return Promise.resolve(this.onMessage(ws, user, message))
  }

  // Drive onConnect directly to assert canWrite computation.
  public connect(user: UserAttachment): UserAttachment {
    return this.onConnect({} as WebSocket, user) as UserAttachment
  }

  // Read-only peek at cron_tasks for assertions.
  public pausedState(db: Database.Database, name: string): number {
    return (
      db.prepare(`SELECT paused FROM cron_tasks WHERE name = ?`).get(name) as
        | { paused: number }
        | undefined
    )?.paused ?? -1
  }
}

describe('CronRoom message handlers', () => {
  it('CRON_PAUSE flips paused=1 and broadcasts CRON_STATUS', async () => {
    const db = new Database(':memory:')
    const { state } = makeState(db)
    const config: CronRoomConfig = {
      tasks: [{ name: 'heartbeat', intervalMinutes: 1 }],
    }
    const room = new TestCronRoom(state, {}, config)
    room.init()

    // Sanity: task is unpaused on construction.
    const beforeRow = db.prepare(`SELECT paused FROM cron_tasks WHERE name = ?`).get('heartbeat') as { paused: number }
    expect(beforeRow.paused).toBe(0)

    // Drive the message handler with a CRON_PAUSE frame, exactly as the
    // base-room WS dispatcher would after parsing the JSON wire frame.
    await room.dispatch({ type: MSG.CRON_PAUSE, payload: { taskName: 'heartbeat' } })

    // Side effect 1: the row is now paused.
    const afterRow = db.prepare(`SELECT paused FROM cron_tasks WHERE name = ?`).get('heartbeat') as { paused: number }
    expect(afterRow.paused).toBe(1)

    // Side effect 2: a CRON_STATUS broadcast went out so other connected
    // monitors update their view without a reconnect.
    expect(room.broadcasts).toHaveLength(1)
    const status = room.broadcasts[0]
    expect(status.type).toBe(MSG.CRON_STATUS)
    const statusPayload = status.payload as { tasks: { name: string; paused: boolean }[]; recentHistory: unknown[] }
    const heartbeat = statusPayload.tasks.find(t => t.name === 'heartbeat')
    expect(heartbeat?.paused).toBe(true)
  })
})

describe('validateTask', () => {
  it('accepts a valid interval task', () => {
    expect(() => validateTask({ name: 'heartbeat', intervalMinutes: 1 })).not.toThrow()
  })

  it('accepts a valid cron task', () => {
    expect(() => validateTask({ name: 'daily', schedule: '0 9 * * *', timezone: 'America/New_York' })).not.toThrow()
  })

  it('rejects ambiguous configs (both interval and schedule)', () => {
    expect(() =>
      validateTask({ name: 'bad', intervalMinutes: 5, schedule: '0 * * * *', timezone: 'UTC' }),
    ).toThrow(/cannot mix/)
  })

  it('rejects missing schedule/interval', () => {
    expect(() => validateTask({ name: 'empty' })).toThrow(/either intervalMinutes or schedule/)
  })

  it('rejects schedule without timezone', () => {
    expect(() => validateTask({ name: 'tz-missing', schedule: '0 9 * * *' })).toThrow()
  })

  it('rejects malformed cron expression at validation time', () => {
    expect(() =>
      validateTask({ name: 'bad-cron', schedule: '* * * *', timezone: 'UTC' }),
    ).toThrow(/5 fields/)
  })

  it('rejects bad task names', () => {
    expect(() => validateTask({ name: 'BadName', intervalMinutes: 1 })).toThrow()
    expect(() => validateTask({ name: 'with space', intervalMinutes: 1 })).toThrow()
  })

  it('rejects out-of-range intervalMinutes', () => {
    expect(() => validateTask({ name: 'too-low', intervalMinutes: 0 })).toThrow()
    expect(() => validateTask({ name: 'too-high', intervalMinutes: 99999 })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Write-role gating — viewers / anonymous can read cron state but cannot
// trigger, pause, or resume tasks. Before this gate, any unauthenticated
// WebSocket could pause production cron jobs or fire them manually.
// ---------------------------------------------------------------------------

describe('CronRoom.onConnect emits AUTH frame to client', () => {
  function makeRoom(): TestCronRoom {
    const db = new Database(':memory:')
    const { state } = makeState(db)
    const room = new TestCronRoom(state, {}, { tasks: [{ name: 'heartbeat', intervalMinutes: 1 }] })
    room.init()
    return room
  }

  it('sends {canWrite:true} to a member', () => {
    const room = makeRoom()
    room.connect({ userId: 'm', userName: '', userEmail: '', role: ROLES.MEMBER })
    const auth = room.sent.find(m => m.type === MSG.AUTH)
    expect(auth).toBeDefined()
    expect((auth?.payload as { canWrite: boolean }).canWrite).toBe(true)
  })

  it('sends {canWrite:false} to a viewer', () => {
    const room = makeRoom()
    room.connect({ userId: 'v', userName: '', userEmail: '', role: ROLES.VIEWER })
    const auth = room.sent.find(m => m.type === MSG.AUTH)
    expect(auth).toBeDefined()
    expect((auth?.payload as { canWrite: boolean }).canWrite).toBe(false)
  })

  it('sends {canWrite:false} to anonymous (no role)', () => {
    const room = makeRoom()
    room.connect({ userId: 'anon', userName: '', userEmail: '' })
    const auth = room.sent.find(m => m.type === MSG.AUTH)
    expect(auth).toBeDefined()
    expect((auth?.payload as { canWrite: boolean }).canWrite).toBe(false)
  })
})

describe('CronRoom.onConnect computes canWrite from role', () => {
  function makeRoom(): TestCronRoom {
    const db = new Database(':memory:')
    const { state } = makeState(db)
    const room = new TestCronRoom(state, {}, {
      tasks: [{ name: 'heartbeat', intervalMinutes: 1 }],
    })
    room.init()
    return room
  }

  it('grants canWrite to members and admins', () => {
    const room = makeRoom()
    const m = room.connect({ userId: 'm', userName: '', userEmail: '', role: ROLES.MEMBER }) as
      UserAttachment & { canWrite: boolean }
    const a = room.connect({ userId: 'a', userName: '', userEmail: '', role: ROLES.ADMIN }) as
      UserAttachment & { canWrite: boolean }
    expect(m.canWrite).toBe(true)
    expect(a.canWrite).toBe(true)
  })

  it('denies canWrite to viewers and anonymous', () => {
    const room = makeRoom()
    const v = room.connect({ userId: 'v', userName: '', userEmail: '', role: ROLES.VIEWER }) as
      UserAttachment & { canWrite: boolean }
    const anon = room.connect({ userId: 'anon-x', userName: '', userEmail: '' }) as
      UserAttachment & { canWrite: boolean }
    expect(v.canWrite).toBe(false)
    expect(anon.canWrite).toBe(false)
  })
})

describe('CronRoom mutation gating', () => {
  const viewer: UserAttachment = {
    userId: 'v', userName: 'V', userEmail: '', role: ROLES.VIEWER, canWrite: false,
  }
  const anon: UserAttachment = {
    userId: 'anon-y', userName: '', userEmail: '', canWrite: false,
  }

  function setup(): { room: TestCronRoom; db: Database.Database } {
    const db = new Database(':memory:')
    const { state } = makeState(db)
    const room = new TestCronRoom(state, {}, {
      tasks: [{ name: 'heartbeat', intervalMinutes: 1 }],
    })
    room.init()
    return { room, db }
  }

  it('CRON_PAUSE from a viewer does NOT flip paused and does NOT broadcast', async () => {
    const { room, db } = setup()
    expect(room.pausedState(db, 'heartbeat')).toBe(0)

    await room.dispatch({ type: MSG.CRON_PAUSE, payload: { taskName: 'heartbeat' } }, viewer)

    expect(room.pausedState(db, 'heartbeat')).toBe(0) // still unpaused
    expect(room.broadcasts.filter(m => m.type === MSG.CRON_STATUS)).toHaveLength(0)
  })

  it('CRON_PAUSE from anonymous does NOT flip paused', async () => {
    const { room, db } = setup()
    await room.dispatch({ type: MSG.CRON_PAUSE, payload: { taskName: 'heartbeat' } }, anon)
    expect(room.pausedState(db, 'heartbeat')).toBe(0)
  })

  it('CRON_TRIGGER from a viewer does NOT execute the task', async () => {
    // executeTask writes a row to cron_history; assert the table stays
    // empty so a future refactor that drops CRON_TRIGGER from the write
    // set fails loudly here.
    const { room, db } = setup()
    await room.dispatch({ type: MSG.CRON_TRIGGER, payload: { taskName: 'heartbeat' } }, viewer)
    const historyCount = (db.prepare(`SELECT COUNT(*) as n FROM cron_history`).get() as { n: number }).n
    expect(historyCount).toBe(0)
  })

  it('CRON_RESUME from a viewer does NOT flip paused', async () => {
    const { room, db } = setup()
    // First pause as admin so resume has something to do.
    await room.dispatch({ type: MSG.CRON_PAUSE, payload: { taskName: 'heartbeat' } })
    expect(room.pausedState(db, 'heartbeat')).toBe(1)
    room.broadcasts.length = 0

    await room.dispatch({ type: MSG.CRON_RESUME, payload: { taskName: 'heartbeat' } }, viewer)
    expect(room.pausedState(db, 'heartbeat')).toBe(1) // still paused
    expect(room.broadcasts).toHaveLength(0)
  })
})

describe('CronRoom read-only operations remain open', () => {
  it('CRON_TASKS request from a viewer responds with the task list', async () => {
    const db = new Database(':memory:')
    const { state } = makeState(db)
    const room = new TestCronRoom(state, {}, { tasks: [{ name: 'heartbeat', intervalMinutes: 1 }] })
    room.init()

    const viewer: UserAttachment = {
      userId: 'v', userName: '', userEmail: '', role: ROLES.VIEWER, canWrite: false,
    }
    await room.dispatch({ type: MSG.CRON_TASKS, payload: {} }, viewer)

    // The viewer must receive the task list, NOT a write-access ERROR.
    // Asserting both halves: presence of the expected reply AND absence of
    // the deny path. If a future refactor accidentally adds CRON_TASKS to
    // CRON_WRITE_TYPES, both assertions fail loudly.
    const tasksReply = room.sent.find(m => m.type === MSG.CRON_TASKS)
    expect(tasksReply).toBeDefined()
    expect(room.sent.some(m => m.type === MSG.ERROR)).toBe(false)
  })
})
