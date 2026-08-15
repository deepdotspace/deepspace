/** CronRoom Durable Object state, execution, and authorization tests. */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { CronRoom, type CronRoomConfig } from '../cron-room'
import { MSG } from '../../../shared/protocol/constants'
import { ROLES } from '../../../shared/roles'
import type { UserAttachment } from '../base-room'
import type { ServerMessage } from '../../../shared/protocol/messages'

// BaseRoom's constructor calls `new WebSocketRequestResponsePair('ping', 'pong')`
// which only exists in the workerd runtime. Vitest runs under node, so stub
// the constructor with a no-op class so we can instantiate a CronRoom.
;(globalThis as { WebSocketRequestResponsePair?: unknown }).WebSocketRequestResponsePair ??= class {
  constructor(_req: string, _resp: string) {}
}

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
  public executed: string[] = []

  protected onTask(taskName: string): void {
    this.executed.push(taskName)
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
      (
        db.prepare(`SELECT paused FROM cron_tasks WHERE name = ?`).get(name) as
          | { paused: number }
          | undefined
      )?.paused ?? -1
    )
  }
}

describe('CronRoom configuration boundary', () => {
  it('rejects an invalid schedule before creating scheduler tables', () => {
    const db = new Database(':memory:')
    const { state } = makeState(db)

    expect(
      () =>
        new TestCronRoom(
          state,
          {},
          {
            tasks: [{ name: 'bad-cron', schedule: '* * * *', timezone: 'UTC' }],
          },
        ),
    ).toThrow(/5 fields/)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([])
  })
})

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
    const beforeRow = db
      .prepare(`SELECT paused FROM cron_tasks WHERE name = ?`)
      .get('heartbeat') as { paused: number }
    expect(beforeRow.paused).toBe(0)

    // Drive the message handler with a CRON_PAUSE frame, exactly as the
    // base-room WS dispatcher would after parsing the JSON wire frame.
    await room.dispatch({ type: MSG.CRON_PAUSE, payload: { taskName: 'heartbeat' } })

    // Side effect 1: the row is now paused.
    const afterRow = db
      .prepare(`SELECT paused FROM cron_tasks WHERE name = ?`)
      .get('heartbeat') as { paused: number }
    expect(afterRow.paused).toBe(1)

    // Side effect 2: a CRON_STATUS broadcast went out so other connected
    // monitors update their view without a reconnect.
    expect(room.broadcasts).toHaveLength(1)
    const status = room.broadcasts[0]
    expect(status.type).toBe(MSG.CRON_STATUS)
    const statusPayload = status.payload as {
      tasks: { name: string; paused: boolean }[]
      recentHistory: unknown[]
    }
    const heartbeat = statusPayload.tasks.find((t) => t.name === 'heartbeat')
    expect(heartbeat?.paused).toBe(true)
  })

  it('rejects an unknown manual task before invoking application code or writing history', async () => {
    const db = new Database(':memory:')
    const { state } = makeState(db)
    const room = new TestCronRoom(
      state,
      {},
      {
        tasks: [{ name: 'heartbeat', intervalMinutes: 1 }],
      },
    )
    room.init()

    await room.dispatch({ type: MSG.CRON_TRIGGER, payload: { taskName: 'not-configured' } })

    expect(room.executed).toEqual([])
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM cron_history').get() as { count: number }).count,
    ).toBe(0)
    expect(room.sent).toContainEqual({
      type: MSG.ERROR,
      payload: { error: 'Unknown cron task: not-configured' },
    })
    // No requestId on the frame → receipts stay opt-in; no CRON_ACK.
    expect(room.sent.some((m) => m.type === MSG.CRON_ACK)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Mutation receipts — a trigger/pause/resume carrying a requestId gets a
// CRON_ACK addressed to its sender once the mutation lands. Triggers run to
// completion inline, so the ok receipt doubles as the completion record.
// ---------------------------------------------------------------------------

describe('CronRoom mutation receipts', () => {
  function setup(): { room: TestCronRoom; db: Database.Database } {
    const db = new Database(':memory:')
    const { state } = makeState(db)
    const room = new TestCronRoom(state, {}, { tasks: [{ name: 'heartbeat', intervalMinutes: 1 }] })
    room.init()
    return { room, db }
  }

  it('CRON_TRIGGER with a requestId acks ok:true with the execution receipt', async () => {
    const { room } = setup()

    await room.dispatch({
      type: MSG.CRON_TRIGGER,
      payload: { taskName: 'heartbeat', requestId: 'req-1' },
    })

    expect(room.executed).toEqual(['heartbeat'])
    expect(room.sent).toContainEqual({
      type: MSG.CRON_ACK,
      payload: {
        requestId: 'req-1',
        taskName: 'heartbeat',
        ok: true,
      },
    })
  })

  it('a mid-operation throw still settles the receipt ok:false', async () => {
    const { room } = setup()
    // Simulate a DO-level failure on the last step of CRON_PAUSE
    // (broadcastStatus → broadcast). BaseRoom's webSocketMessage swallows
    // onMessage throws without closing the socket, so without the ack-on-
    // throw chokepoint the caller's receipt promise would never settle.
    ;(room as unknown as { broadcast(m: ServerMessage): void }).broadcast = () => {
      throw new Error('storage exploded')
    }

    await expect(
      room.dispatch({
        type: MSG.CRON_PAUSE,
        payload: { taskName: 'heartbeat', requestId: 'req-throw' },
      }),
    ).rejects.toThrow('storage exploded')

    expect(room.sent).toContainEqual({
      type: MSG.CRON_ACK,
      payload: {
        requestId: 'req-throw',
        taskName: 'heartbeat',
        ok: false,
        reason: 'failed',
        error: 'storage exploded',
      },
    })
  })

  it('CRON_TRIGGER for an unknown task acks ok:false unknown_task alongside the ERROR frame', async () => {
    const { room } = setup()

    await room.dispatch({
      type: MSG.CRON_TRIGGER,
      payload: { taskName: 'not-configured', requestId: 'req-2' },
    })

    expect(room.sent).toContainEqual({
      type: MSG.CRON_ACK,
      payload: {
        requestId: 'req-2',
        taskName: 'not-configured',
        ok: false,
        reason: 'unknown_task',
        error: 'Unknown cron task: not-configured',
      },
    })
    // The untyped ERROR channel stays for listeners that predate receipts.
    expect(room.sent).toContainEqual({
      type: MSG.ERROR,
      payload: { error: 'Unknown cron task: not-configured' },
    })
  })

  it('a throwing task acks ok:false failed with the task error', async () => {
    const db = new Database(':memory:')
    const { state } = makeState(db)
    class FailingCronRoom extends TestCronRoom {
      protected onTask(): void {
        throw new Error('task exploded')
      }
    }
    const room = new FailingCronRoom(state, {}, { tasks: [{ name: 'heartbeat', intervalMinutes: 1 }] })
    room.init()

    await room.dispatch({
      type: MSG.CRON_TRIGGER,
      payload: { taskName: 'heartbeat', requestId: 'req-3' },
    })

    expect(room.sent).toContainEqual({
      type: MSG.CRON_ACK,
      payload: {
        requestId: 'req-3',
        taskName: 'heartbeat',
        ok: false,
        reason: 'failed',
        error: 'task exploded',
      },
    })
  })

  it('CRON_PAUSE with a requestId acks ok:true after the state flip', async () => {
    const { room, db } = setup()

    await room.dispatch({
      type: MSG.CRON_PAUSE,
      payload: { taskName: 'heartbeat', requestId: 'req-4' },
    })

    expect(room.pausedState(db, 'heartbeat')).toBe(1)
    expect(room.sent).toContainEqual({
      type: MSG.CRON_ACK,
      payload: { requestId: 'req-4', taskName: 'heartbeat', ok: true },
    })
  })

  it('CRON_PAUSE for an unknown task acks ok:false unknown_task and flips nothing', async () => {
    const { room, db } = setup()

    await room.dispatch({
      type: MSG.CRON_PAUSE,
      payload: { taskName: 'not-configured', requestId: 'req-5' },
    })

    expect(room.sent).toContainEqual({
      type: MSG.CRON_ACK,
      payload: {
        requestId: 'req-5',
        taskName: 'not-configured',
        ok: false,
        reason: 'unknown_task',
        error: 'Unknown cron task: not-configured',
      },
    })
    // The configured task is untouched and no CRON_STATUS broadcast went out.
    expect(room.pausedState(db, 'heartbeat')).toBe(0)
    expect(room.broadcasts).toHaveLength(0)
  })

  it('CRON_PAUSE without a taskName acks ok:false failed instead of ok:true', async () => {
    const { room, db } = setup()

    await room.dispatch({ type: MSG.CRON_PAUSE, payload: { requestId: 'req-6' } })

    expect(room.sent).toContainEqual({
      type: MSG.CRON_ACK,
      payload: { requestId: 'req-6', ok: false, reason: 'failed', error: 'Missing taskName' },
    })
    expect(room.pausedState(db, 'heartbeat')).toBe(0)
    expect(room.broadcasts).toHaveLength(0)
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
    const auth = room.sent.find((m) => m.type === MSG.AUTH)
    expect(auth).toBeDefined()
    expect((auth?.payload as { canWrite: boolean }).canWrite).toBe(true)
  })

  it('sends {canWrite:false} to a viewer', () => {
    const room = makeRoom()
    room.connect({ userId: 'v', userName: '', userEmail: '', role: ROLES.VIEWER })
    const auth = room.sent.find((m) => m.type === MSG.AUTH)
    expect(auth).toBeDefined()
    expect((auth?.payload as { canWrite: boolean }).canWrite).toBe(false)
  })

  it('sends {canWrite:false} to anonymous (no role)', () => {
    const room = makeRoom()
    room.connect({ userId: 'anon', userName: '', userEmail: '' })
    const auth = room.sent.find((m) => m.type === MSG.AUTH)
    expect(auth).toBeDefined()
    expect((auth?.payload as { canWrite: boolean }).canWrite).toBe(false)
  })
})

describe('CronRoom.onConnect computes canWrite from role', () => {
  function makeRoom(): TestCronRoom {
    const db = new Database(':memory:')
    const { state } = makeState(db)
    const room = new TestCronRoom(
      state,
      {},
      {
        tasks: [{ name: 'heartbeat', intervalMinutes: 1 }],
      },
    )
    room.init()
    return room
  }

  it('grants canWrite to members and admins', () => {
    const room = makeRoom()
    const m = room.connect({
      userId: 'm',
      userName: '',
      userEmail: '',
      role: ROLES.MEMBER,
    }) as UserAttachment & { canWrite: boolean }
    const a = room.connect({
      userId: 'a',
      userName: '',
      userEmail: '',
      role: ROLES.ADMIN,
    }) as UserAttachment & { canWrite: boolean }
    expect(m.canWrite).toBe(true)
    expect(a.canWrite).toBe(true)
  })

  it('denies canWrite to viewers and anonymous', () => {
    const room = makeRoom()
    const v = room.connect({
      userId: 'v',
      userName: '',
      userEmail: '',
      role: ROLES.VIEWER,
    }) as UserAttachment & { canWrite: boolean }
    const anon = room.connect({
      userId: 'anon-x',
      userName: '',
      userEmail: '',
    }) as UserAttachment & { canWrite: boolean }
    expect(v.canWrite).toBe(false)
    expect(anon.canWrite).toBe(false)
  })
})

describe('CronRoom mutation gating', () => {
  const viewer: UserAttachment = {
    userId: 'v',
    userName: 'V',
    userEmail: '',
    role: ROLES.VIEWER,
    canWrite: false,
  }
  const anon: UserAttachment = {
    userId: 'anon-y',
    userName: '',
    userEmail: '',
    canWrite: false,
  }

  function setup(): { room: TestCronRoom; db: Database.Database } {
    const db = new Database(':memory:')
    const { state } = makeState(db)
    const room = new TestCronRoom(
      state,
      {},
      {
        tasks: [{ name: 'heartbeat', intervalMinutes: 1 }],
      },
    )
    room.init()
    return { room, db }
  }

  it('CRON_PAUSE from a viewer does NOT flip paused and does NOT broadcast', async () => {
    const { room, db } = setup()
    expect(room.pausedState(db, 'heartbeat')).toBe(0)

    await room.dispatch({ type: MSG.CRON_PAUSE, payload: { taskName: 'heartbeat' } }, viewer)

    expect(room.pausedState(db, 'heartbeat')).toBe(0) // still unpaused
    expect(room.broadcasts.filter((m) => m.type === MSG.CRON_STATUS)).toHaveLength(0)
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
    const historyCount = (
      db.prepare(`SELECT COUNT(*) as n FROM cron_history`).get() as { n: number }
    ).n
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
      userId: 'v',
      userName: '',
      userEmail: '',
      role: ROLES.VIEWER,
      canWrite: false,
    }
    await room.dispatch({ type: MSG.CRON_TASKS, payload: {} }, viewer)

    // The viewer must receive the task list, NOT a write-access ERROR.
    // Asserting both halves: presence of the expected reply AND absence of
    // the deny path. If a future refactor accidentally adds CRON_TASKS to
    // CRON_WRITE_TYPES, both assertions fail loudly.
    const tasksReply = room.sent.find((m) => m.type === MSG.CRON_TASKS)
    expect(tasksReply).toBeDefined()
    expect(room.sent.some((m) => m.type === MSG.ERROR)).toBe(false)
  })
})
