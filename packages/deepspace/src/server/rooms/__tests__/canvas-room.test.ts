/**
 * CanvasRoom write-role gating tests.
 *
 * Locks in the SDK contract that viewers (including unauthenticated
 * anonymous connections, whose role is undefined) can observe the
 * canvas but cannot mutate it. Mutations must come from a member or
 * admin role. Viewport broadcasts are presence-like and intentionally
 * open to viewers — they only announce "I am looking here," parallel
 * to PresenceRoom.
 *
 * Before this gate, any anonymous WebSocket could send CANVAS_DELETE /
 * CANVAS_ADD and silently wipe or corrupt the shared canvas.
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { CanvasRoom } from '../canvas-room'
import { MSG } from '../../../shared/protocol/constants'
import { ROLES } from '../../../shared/roles'
import type { UserAttachment } from '../base-room'
import type { ServerMessage } from '../../../shared/protocol/messages'

;(globalThis as { WebSocketRequestResponsePair?: unknown }).WebSocketRequestResponsePair ??=
  class { constructor(_req: string, _resp: string) {} }

// ---------------------------------------------------------------------------
// SqlStorage shim over better-sqlite3 (same shape as cron-room.test.ts)
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
        const rows = stmt.all(...(bindings as never[]))
        return { toArray: () => rows }
      }
      stmt.run(...(bindings as never[]))
      return { toArray: () => [] }
    },
    get databaseSize(): number {
      return 0
    },
  } as unknown as SqlStorage
}

function makeState(db: Database.Database): DurableObjectState {
  return {
    storage: {
      sql: makeSql(db),
      setAlarm() {},
    },
    setWebSocketAutoResponse() {},
    getWebSockets(): WebSocket[] {
      return []
    },
    acceptWebSocket() {},
  } as unknown as DurableObjectState
}

// ---------------------------------------------------------------------------
// TestCanvasRoom — exposes protected hooks, captures broadcasts/sends.
// ---------------------------------------------------------------------------

class TestCanvasRoom extends CanvasRoom {
  public broadcasts: ServerMessage[] = []
  public sent: ServerMessage[] = []

  protected broadcast(message: ServerMessage, _exclude?: WebSocket): void {
    this.broadcasts.push(message)
  }

  protected sendTo(_ws: WebSocket, message: ServerMessage): void {
    this.sent.push(message)
  }

  public dispatch(
    user: UserAttachment,
    message: { type: string; payload: Record<string, unknown> },
  ): Promise<void> {
    return Promise.resolve(this.onMessage({} as WebSocket, user, message))
  }

  public connect(user: UserAttachment): UserAttachment {
    // onConnect may be sync or async; CanvasRoom's is sync. Cast through unknown
    // to satisfy the broader BaseRoom signature without await.
    return this.onConnect({} as WebSocket, user) as UserAttachment
  }

  public shapeCount(): number {
    return (this as unknown as { getShapesMap: () => Map<unknown, unknown> })
      .getShapesMap()
      .size
  }
}

function makeRoom(): TestCanvasRoom {
  const db = new Database(':memory:')
  return new TestCanvasRoom(makeState(db), {})
}

const memberAttach = (canWrite = true): UserAttachment => ({
  userId: 'member-1',
  userName: 'Member',
  userEmail: '',
  role: ROLES.MEMBER,
  canWrite,
})

const viewerAttach = (): UserAttachment => ({
  userId: 'viewer-1',
  userName: 'Viewer',
  userEmail: '',
  role: ROLES.VIEWER,
  canWrite: false,
})

const anonAttach = (): UserAttachment => ({
  // No role at all — matches how BaseRoom builds an attachment when the
  // edge worker accepts a tokenless WebSocket upgrade.
  userId: 'anon-zzz',
  userName: 'Anonymous',
  userEmail: '',
  canWrite: false,
})

// ---------------------------------------------------------------------------

describe('CanvasRoom.onConnect emits AUTH frame to client', () => {
  it('sends {canWrite:true} to a member', () => {
    const room = makeRoom()
    room.connect({ userId: 'm', userName: 'M', userEmail: '', role: ROLES.MEMBER })
    const auth = room.sent.find(m => m.type === MSG.AUTH)
    expect(auth).toBeDefined()
    expect((auth?.payload as { canWrite: boolean }).canWrite).toBe(true)
  })

  it('sends {canWrite:false} to a viewer', () => {
    const room = makeRoom()
    room.connect({ userId: 'v', userName: 'V', userEmail: '', role: ROLES.VIEWER })
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

describe('CanvasRoom.onConnect computes canWrite from role', () => {
  it('grants canWrite to members', () => {
    const room = makeRoom()
    const attachment = room.connect({
      userId: 'm', userName: 'M', userEmail: '', role: ROLES.MEMBER,
    }) as UserAttachment & { canWrite: boolean }
    expect(attachment.canWrite).toBe(true)
  })

  it('grants canWrite to admins', () => {
    const room = makeRoom()
    const attachment = room.connect({
      userId: 'a', userName: 'A', userEmail: '', role: ROLES.ADMIN,
    }) as UserAttachment & { canWrite: boolean }
    expect(attachment.canWrite).toBe(true)
  })

  it('denies canWrite to viewers', () => {
    const room = makeRoom()
    const attachment = room.connect({
      userId: 'v', userName: 'V', userEmail: '', role: ROLES.VIEWER,
    }) as UserAttachment & { canWrite: boolean }
    expect(attachment.canWrite).toBe(false)
  })

  it('denies canWrite to unauthenticated anonymous (no role)', () => {
    const room = makeRoom()
    const attachment = room.connect({
      userId: 'anon-x', userName: 'Anonymous', userEmail: '',
    }) as UserAttachment & { canWrite: boolean }
    expect(attachment.canWrite).toBe(false)
  })
})

describe('CanvasRoom mutation gating', () => {
  it('blocks CANVAS_ADD from a viewer and emits ERROR', async () => {
    const room = makeRoom()
    await room.dispatch(viewerAttach(), {
      type: MSG.CANVAS_ADD,
      payload: { type: 'rect', x: 0, y: 0, width: 10, height: 10 },
    })
    expect(room.shapeCount()).toBe(0)
    expect(room.broadcasts).toHaveLength(0)
    expect(room.sent.some((m) => m.type === MSG.ERROR)).toBe(true)
  })

  it('blocks CANVAS_ADD from anonymous (no role)', async () => {
    const room = makeRoom()
    await room.dispatch(anonAttach(), {
      type: MSG.CANVAS_ADD,
      payload: { type: 'rect', x: 0, y: 0, width: 10, height: 10 },
    })
    expect(room.shapeCount()).toBe(0)
  })

  it('blocks CANVAS_DELETE from a viewer', async () => {
    const room = makeRoom()
    // Seed a shape as a member first.
    await room.dispatch(memberAttach(), {
      type: MSG.CANVAS_ADD,
      payload: { id: 's1', type: 'rect', x: 0, y: 0, width: 10, height: 10 },
    })
    expect(room.shapeCount()).toBe(1)

    // Viewer tries to delete it.
    await room.dispatch(viewerAttach(), {
      type: MSG.CANVAS_DELETE,
      payload: { shapeId: 's1' },
    })
    expect(room.shapeCount()).toBe(1) // still there
  })

  it('blocks CANVAS_MOVE / CANVAS_RESIZE / CANVAS_UPDATE / CANVAS_UNDO / CANVAS_REDO from anonymous', async () => {
    const room = makeRoom()
    await room.dispatch(memberAttach(), {
      type: MSG.CANVAS_ADD,
      payload: { id: 's1', type: 'rect', x: 0, y: 0, width: 10, height: 10 },
    })
    const broadcastsBefore = room.broadcasts.length

    const anon = anonAttach()
    await room.dispatch(anon, { type: MSG.CANVAS_MOVE, payload: { shapeId: 's1', x: 50, y: 50 } })
    await room.dispatch(anon, { type: MSG.CANVAS_RESIZE, payload: { shapeId: 's1', width: 99, height: 99 } })
    await room.dispatch(anon, { type: MSG.CANVAS_UPDATE, payload: { shapeId: 's1', props: { color: 'red' } } })
    await room.dispatch(anon, { type: MSG.CANVAS_UNDO, payload: {} })
    await room.dispatch(anon, { type: MSG.CANVAS_REDO, payload: {} })

    // No mutation broadcast went out for any of those attempts.
    expect(room.broadcasts.length).toBe(broadcastsBefore)
  })
})

describe('CanvasRoom non-mutation passthrough', () => {
  it('allows CANVAS_VIEWPORT from a viewer (presence-like)', async () => {
    const room = makeRoom()
    const viewer = viewerAttach()
    await room.dispatch(viewer, {
      type: MSG.CANVAS_VIEWPORT,
      payload: { x: 0, y: 0, width: 100, height: 100, zoom: 1 },
    })
    // Viewport is broadcast so other clients can see "this viewer is looking here."
    expect(room.broadcasts.some((m) => m.type === MSG.CANVAS_VIEWPORT)).toBe(true)
  })
})

describe('CanvasRoom member writes still work after gate', () => {
  it('allows CANVAS_ADD from a member', async () => {
    const room = makeRoom()
    await room.dispatch(memberAttach(), {
      type: MSG.CANVAS_ADD,
      payload: { type: 'rect', x: 0, y: 0, width: 10, height: 10 },
    })
    expect(room.shapeCount()).toBe(1)
  })

  it('allows CANVAS_ADD from an admin', async () => {
    const room = makeRoom()
    await room.dispatch(
      { userId: 'a', userName: 'A', userEmail: '', role: ROLES.ADMIN, canWrite: true },
      {
        type: MSG.CANVAS_ADD,
        payload: { type: 'rect', x: 0, y: 0, width: 10, height: 10 },
      },
    )
    expect(room.shapeCount()).toBe(1)
  })
})
