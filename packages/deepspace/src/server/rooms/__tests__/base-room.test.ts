/**
 * BaseRoom.disconnectAllSockets + POST /internal/disconnect-sockets.
 *
 * Locks in the SDK contract that a room can force every connected client to
 * reconnect and resync after an out-of-band, server-side write:
 *
 *   - disconnectAllSockets() closes every live socket with close code 1012
 *     ("service restart") and reason 'state-refresh', returns the count, and
 *     guards each close so one already-closing socket can't abort the sweep.
 *   - The built-in POST /internal/disconnect-sockets endpoint (handled in
 *     BaseRoom.fetch) calls it and returns { success: true, closed: n }.
 *   - An optional JSON body { code, reason } overrides the defaults.
 *   - Non-internal requests fall through to the normal fetch path (a bare
 *     GET is a 404), so the internal route can't be reached by accident.
 */

import { describe, it, expect } from 'vitest'
import { BaseRoom } from '../base-room'

;(globalThis as { WebSocketRequestResponsePair?: unknown }).WebSocketRequestResponsePair ??=
  class { constructor(_req: string, _resp: string) {} }

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface CloseCall {
  code?: number
  reason?: string
}

class FakeWebSocket {
  closes: CloseCall[] = []
  constructor(private readonly throwOnClose = false) {}
  close(code?: number, reason?: string): void {
    if (this.throwOnClose) throw new Error('already closing')
    this.closes.push({ code, reason })
  }
}

function makeState(sockets: FakeWebSocket[]): DurableObjectState {
  return {
    storage: { sql: {} as SqlStorage },
    setWebSocketAutoResponse() {},
    getWebSockets(): WebSocket[] {
      return sockets as unknown as WebSocket[]
    },
    acceptWebSocket() {},
  } as unknown as DurableObjectState
}

// BaseRoom is abstract (onMessage). Minimal concrete subclass for tests.
class TestRoom extends BaseRoom {
  protected onMessage(): void {}
}

function makeRoom(sockets: FakeWebSocket[]): TestRoom {
  return new TestRoom(makeState(sockets), {})
}

function post(body?: unknown): Request {
  return new Request('https://internal/internal/disconnect-sockets', {
    method: 'POST',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

// ---------------------------------------------------------------------------

describe('BaseRoom.disconnectAllSockets', () => {
  it('closes every socket with 1012 / state-refresh and returns the count', () => {
    const sockets = [new FakeWebSocket(), new FakeWebSocket(), new FakeWebSocket()]
    const room = makeRoom(sockets)

    const closed = room.disconnectAllSockets()

    expect(closed).toBe(3)
    for (const ws of sockets) {
      expect(ws.closes).toEqual([{ code: 1012, reason: 'state-refresh' }])
    }
  })

  it('honours a custom close code and reason', () => {
    const sockets = [new FakeWebSocket()]
    const room = makeRoom(sockets)

    const closed = room.disconnectAllSockets({ code: 4001, reason: 'migrating' })

    expect(closed).toBe(1)
    expect(sockets[0].closes).toEqual([{ code: 4001, reason: 'migrating' }])
  })

  it('keeps sweeping when one socket throws on close (counts only the ones closed)', () => {
    const ok1 = new FakeWebSocket()
    const bad = new FakeWebSocket(true) // throws on close
    const ok2 = new FakeWebSocket()
    const room = makeRoom([ok1, bad, ok2])

    const closed = room.disconnectAllSockets()

    expect(closed).toBe(2)
    expect(ok1.closes).toHaveLength(1)
    expect(ok2.closes).toHaveLength(1)
    expect(bad.closes).toHaveLength(0)
  })

  it('returns 0 when there are no connected sockets', () => {
    expect(makeRoom([]).disconnectAllSockets()).toBe(0)
  })
})

describe('POST /internal/disconnect-sockets', () => {
  it('closes N sockets and returns { success: true, closed: n }', async () => {
    const sockets = [new FakeWebSocket(), new FakeWebSocket()]
    const room = makeRoom(sockets)

    const res = await room.fetch(post())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, closed: 2 })
    for (const ws of sockets) {
      expect(ws.closes).toEqual([{ code: 1012, reason: 'state-refresh' }])
    }
  })

  it('applies a { code, reason } override from the JSON body', async () => {
    const sockets = [new FakeWebSocket()]
    const room = makeRoom(sockets)

    const res = await room.fetch(post({ code: 4002, reason: 'reindex' }))

    expect(await res.json()).toEqual({ success: true, closed: 1 })
    expect(sockets[0].closes).toEqual([{ code: 4002, reason: 'reindex' }])
  })

  it('falls back to defaults on an empty/malformed body', async () => {
    const sockets = [new FakeWebSocket()]
    const room = makeRoom(sockets)

    // No body at all.
    await room.fetch(post())
    expect(sockets[0].closes).toEqual([{ code: 1012, reason: 'state-refresh' }])
  })

  it('does not treat a bare GET as the internal route (falls through to 404)', async () => {
    const sockets = [new FakeWebSocket()]
    const room = makeRoom(sockets)

    const res = await room.fetch(
      new Request('https://internal/internal/disconnect-sockets', { method: 'GET' }),
    )

    expect(res.status).toBe(404)
    expect(sockets[0].closes).toHaveLength(0)
  })

  it('leaves unrelated paths on the normal dispatch path (404, no sockets closed)', async () => {
    const sockets = [new FakeWebSocket()]
    const room = makeRoom(sockets)

    const res = await room.fetch(
      new Request('https://internal/something-else', { method: 'POST' }),
    )

    expect(res.status).toBe(404)
    expect(sockets[0].closes).toHaveLength(0)
  })
})
