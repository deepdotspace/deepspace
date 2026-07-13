/**
 * GameRoom write-role gating tests.
 *
 * Locks in the SDK contract that viewers / anonymous spectators can
 * watch a game but cannot influence it. Mutating game state — sending
 * inputs, toggling ready, starting or ending the game — requires
 * member or admin. Anonymous connections still receive the GAME_STATE
 * broadcast on connect (they're spectators), but they are not added
 * to the players map, so an unauthenticated visitor cannot block
 * auto-start or appear as a player.
 *
 * Before this gate, any anonymous WebSocket could send GAME_END and
 * forcibly stop a running multiplayer game.
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { GameRoom } from '../game-room'
import { MSG } from '../../../shared/protocol/constants'
import { ROLES } from '../../../shared/roles'
import type { UserAttachment } from '../base-room'
import type { ServerMessage } from '../../../shared/protocol/messages'

;(globalThis as { WebSocketRequestResponsePair?: unknown }).WebSocketRequestResponsePair ??=
  class { constructor(_req: string, _resp: string) {} }

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

// Concrete subclass — GameRoom is abstract because of onTick.
class TestGameRoom extends GameRoom {
  public broadcasts: ServerMessage[] = []
  public sent: ServerMessage[] = []

  protected onTick(): Record<string, unknown> | undefined {
    return undefined
  }

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
    return this.onConnect({} as WebSocket, user) as UserAttachment
  }

  public playerCount(): number {
    return (this as unknown as { getPlayers: () => unknown[] }).getPlayers().length
  }

  public isGameRunning(): boolean {
    return (this as unknown as { isRunning: () => boolean }).isRunning()
  }

  public inputBufferLength(): number {
    return (this as unknown as { inputBuffer: unknown[] }).inputBuffer.length
  }
}

function makeRoom(): TestGameRoom {
  return new TestGameRoom(makeState(new Database(':memory:')), {})
}

const memberAttach = (id = 'm1'): UserAttachment => ({
  userId: id, userName: 'Member', userEmail: '', role: ROLES.MEMBER, canWrite: true,
})
const viewerAttach = (): UserAttachment => ({
  userId: 'v1', userName: 'Viewer', userEmail: '', role: ROLES.VIEWER, canWrite: false,
})
const anonAttach = (): UserAttachment => ({
  userId: 'anon-1', userName: 'Anonymous', userEmail: '', canWrite: false,
})

// ---------------------------------------------------------------------------

describe('GameRoom.onConnect emits AUTH frame to client', () => {
  it('sends {canWrite:true} to a member', () => {
    const room = makeRoom()
    room.connect(memberAttach())
    const auth = room.sent.find(m => m.type === MSG.AUTH)
    expect(auth).toBeDefined()
    expect((auth?.payload as { canWrite: boolean }).canWrite).toBe(true)
  })

  it('sends {canWrite:false} to a spectator viewer', () => {
    const room = makeRoom()
    room.connect(viewerAttach())
    const auth = room.sent.find(m => m.type === MSG.AUTH)
    expect(auth).toBeDefined()
    expect((auth?.payload as { canWrite: boolean }).canWrite).toBe(false)
  })

  it('sends {canWrite:false} to anonymous (no role)', () => {
    const room = makeRoom()
    room.connect(anonAttach())
    const auth = room.sent.find(m => m.type === MSG.AUTH)
    expect(auth).toBeDefined()
    expect((auth?.payload as { canWrite: boolean }).canWrite).toBe(false)
  })
})

describe('GameRoom.onConnect', () => {
  it('adds members to the players map', () => {
    const room = makeRoom()
    room.connect(memberAttach())
    expect(room.playerCount()).toBe(1)
  })

  it('does NOT add viewers to the players map (spectator-only)', () => {
    const room = makeRoom()
    room.connect(viewerAttach())
    expect(room.playerCount()).toBe(0)
  })

  it('does NOT add anonymous users to the players map', () => {
    const room = makeRoom()
    room.connect(anonAttach())
    expect(room.playerCount()).toBe(0)
  })

  it('still sends GAME_STATE to spectators on connect (read-only)', () => {
    const room = makeRoom()
    room.connect(viewerAttach())
    expect(room.sent.some((m) => m.type === MSG.GAME_STATE)).toBe(true)
  })
})

describe('GameRoom mutation gating', () => {
  it('blocks GAME_INPUT from a viewer', async () => {
    const room = makeRoom()
    await room.dispatch(viewerAttach(), {
      type: MSG.GAME_INPUT,
      payload: { action: 'fire', data: {} },
    })
    expect(room.inputBufferLength()).toBe(0)
  })

  it('blocks GAME_INPUT from anonymous', async () => {
    const room = makeRoom()
    await room.dispatch(anonAttach(), {
      type: MSG.GAME_INPUT,
      payload: { action: 'fire', data: {} },
    })
    expect(room.inputBufferLength()).toBe(0)
  })

  it('blocks GAME_END from anonymous (does not stop a running game)', async () => {
    const room = makeRoom()
    // Bootstrap: connect a member, mark ready, game auto-starts.
    room.connect(memberAttach())
    await room.dispatch(memberAttach(), { type: MSG.GAME_PLAYER_READY, payload: {} })
    expect(room.isGameRunning()).toBe(true)

    // Anonymous attempts to end the game.
    await room.dispatch(anonAttach(), { type: MSG.GAME_END, payload: {} })
    expect(room.isGameRunning()).toBe(true)
  })

  it('blocks GAME_START and GAME_PLAYER_READY from viewers', async () => {
    const room = makeRoom()
    const viewer = viewerAttach()
    await room.dispatch(viewer, { type: MSG.GAME_PLAYER_READY, payload: {} })
    await room.dispatch(viewer, { type: MSG.GAME_START, payload: {} })
    expect(room.isGameRunning()).toBe(false)
  })
})

describe('GameRoom members can still drive the game', () => {
  it('accepts GAME_INPUT from a member', async () => {
    const room = makeRoom()
    room.connect(memberAttach())
    await room.dispatch(memberAttach(), {
      type: MSG.GAME_INPUT,
      payload: { action: 'jump', data: {} },
    })
    expect(room.inputBufferLength()).toBe(1)
  })

  it('auto-starts when a single ready member meets minPlayers=1', async () => {
    const room = makeRoom()
    room.connect(memberAttach())
    await room.dispatch(memberAttach(), { type: MSG.GAME_PLAYER_READY, payload: {} })
    expect(room.isGameRunning()).toBe(true)
  })
})
