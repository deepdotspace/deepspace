/**
 * RecordSocket lifecycle — the race-sensitive engine both providers share.
 *
 * These tests pin the behavior that used to live (duplicated and drifted) in
 * context.tsx and RecordScope.tsx: the connect-token guard around the async
 * auth-token fetch, resubscribe-on-open, reset-to-loading + pending-request
 * rejection on close, exponential backoff, identity-change reconnects,
 * zombie-reconnect prevention on teardown, and the message dispatch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RecordSocket, type RecordStoreLike } from '../record-socket'
import { MSG } from '../../../shared/protocol/constants'

// ── fakes ────────────────────────────────────────────────────────────────────

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readyState = 0 // CONNECTING
  binaryType = ''
  sent: string[] = []
  sentBinary: Uint8Array[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.sent.push(data)
    else this.sentBinary.push(data)
  }

  close(): void {
    this.readyState = 3 // CLOSED
    this.onclose?.()
  }

  // test drivers
  serverOpen(): void {
    this.readyState = 1 // OPEN
    this.onopen?.()
  }

  serverMessage(type: string, payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type, payload }) })
  }

  /** Simulate a server-initiated close with a specific code (e.g. 1012). */
  serverClose(code: number, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }

  serverDrop(): void {
    this.readyState = 3
    this.onclose?.()
  }

  sentOfType(type: string): Array<{ type: string; payload: Record<string, unknown> }> {
    return this.sent
      .map((s) => JSON.parse(s) as { type: string; payload: Record<string, unknown> })
      .filter((m) => m.type === type)
  }
}

function fakeStore() {
  return {
    setQueryResult: vi.fn(),
    applyChange: vi.fn(),
    hasRecord: vi.fn(() => false),
    setError: vi.fn(),
    resetToLoading: vi.fn(),
  } satisfies RecordStoreLike & Record<string, ReturnType<typeof vi.fn>>
}

function fakeListeners() {
  return {
    onStatus: vi.fn(),
    onReady: vi.fn(),
    onRole: vi.fn(),
    onUsers: vi.fn(),
    onSchemas: vi.fn(),
    onPermissionError: vi.fn(),
    onValidationError: vi.fn(),
  }
}

interface Harness {
  socket: RecordSocket
  store: ReturnType<typeof fakeStore>
  listeners: ReturnType<typeof fakeListeners>
  getToken: ReturnType<typeof vi.fn>
  /** The most recently created socket instance. */
  ws(): FakeWebSocket
}

function makeSocket(over: { getToken?: () => Promise<string | null> } = {}): Harness {
  const store = fakeStore()
  const listeners = fakeListeners()
  const getToken = vi.fn(over.getToken ?? (async () => 'jwt-token'))
  const socket = new RecordSocket({
    roomId: 'app:test',
    store,
    getToken,
    listeners,
    wsUrl: 'https://example.test',
    extraParams: { appId: 'app_' + 'A'.repeat(26) },
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  })
  return {
    socket,
    store,
    listeners,
    getToken,
    ws: () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1],
  }
}

const QUERY_KEY = JSON.stringify({ collection: 'todos', where: { done: false } })

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
})
afterEach(() => {
  vi.useRealTimers()
})

// ── connect / token race ─────────────────────────────────────────────────────

describe('connect', () => {
  it('builds the URL from wsUrl + path prefix + token + extra params', async () => {
    const h = makeSocket()
    await h.socket.connect()
    expect(h.ws().url).toBe(
      `wss://example.test/ws/app:test?token=jwt-token&appId=app_${'A'.repeat(26)}`,
    )
  })

  it('connects tokenless when the token fetch fails (server decides)', async () => {
    const h = makeSocket({
      getToken: async () => {
        throw new Error('auth down')
      },
    })
    await h.socket.connect()
    expect(h.ws().url).not.toContain('token=')
  })

  it('a disconnect() during the token await wins — no socket is created', async () => {
    let release!: (v: string) => void
    const h = makeSocket({ getToken: () => new Promise((r) => (release = r)) })
    const pending = h.socket.connect()
    h.socket.disconnect() // races in while connect awaits the token
    release('late-token')
    await pending
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('a newer connect() supersedes an older one still awaiting its token', async () => {
    const releases: Array<(v: string) => void> = []
    const h = makeSocket({ getToken: () => new Promise((r) => releases.push(r)) })
    const first = h.socket.connect()
    const second = h.socket.connect()
    releases[0]('token-one') // the superseded connect resolves late…
    releases[1]('token-two')
    await Promise.all([first, second])
    // …and must NOT have opened a second socket.
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(h.ws().url).toContain('token=token-two')
  })

  it('is a no-op while a socket is OPEN or CONNECTING with the same identity', async () => {
    const h = makeSocket()
    await h.socket.connect('user-1')
    expect(FakeWebSocket.instances).toHaveLength(1)
    await h.socket.connect('user-1') // CONNECTING → no-op
    h.ws().serverOpen()
    await h.socket.connect('user-1') // OPEN, same identity → no-op
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('an identity change on an OPEN socket forces a reconnect', async () => {
    const h = makeSocket()
    await h.socket.connect('') // anonymous
    h.ws().serverOpen()
    const anonWs = h.ws()

    await h.socket.connect('user-1') // signed in mid-connection
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(h.ws()).not.toBe(anonWs)
    // the old socket was torn down silently — no disconnected status, no
    // zombie reconnect from ITS onclose
    expect(anonWs.onclose).toBeNull()
    expect(h.listeners.onStatus).not.toHaveBeenCalledWith('disconnected')
  })
})

describe('registry persistence across socket swaps', () => {
  it('a replacement socket sharing the registries resubscribes the old subscriptions', async () => {
    const store = fakeStore()
    const listeners = fakeListeners()
    const subscriptions = new Map<string, string>()
    const config = {
      roomId: 'app:test',
      store,
      getToken: async () => 'jwt',
      listeners,
      wsUrl: 'https://example.test',
      subscriptions,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    }
    const first = new RecordSocket(config)
    first.registerSubscription('sub-1', QUERY_KEY)
    await first.connect('')
    first.destroy()

    // Auth changed → the provider recreates the socket with the same
    // registries; hook-registered subscriptions must survive the swap.
    const second = new RecordSocket(config)
    await second.connect('user-1')
    FakeWebSocket.instances.at(-1)!.serverOpen()
    expect(FakeWebSocket.instances.at(-1)!.sentOfType(MSG.SUBSCRIBE)).toHaveLength(1)
  })
})

// ── open: resubscribe ────────────────────────────────────────────────────────

describe('open', () => {
  it('reports connected and re-subscribes every registered query', async () => {
    const h = makeSocket()
    h.socket.registerSubscription('sub-1', QUERY_KEY)
    await h.socket.connect()
    h.ws().serverOpen()

    expect(h.listeners.onStatus).toHaveBeenCalledWith('connected')
    const subs = h.ws().sentOfType(MSG.SUBSCRIBE)
    expect(subs).toHaveLength(1)
    expect(subs[0].payload).toEqual({ subscriptionId: 'sub-1', query: JSON.parse(QUERY_KEY) })
  })

  it('USER_INFO marks ready, reports the role, and auto-requests the user list', async () => {
    const h = makeSocket()
    await h.socket.connect()
    h.ws().serverOpen()
    h.ws().serverMessage(MSG.USER_INFO, { role: 'admin' })

    expect(h.listeners.onRole).toHaveBeenCalledWith('admin')
    expect(h.listeners.onReady).toHaveBeenCalledWith(true)
    expect(h.ws().sentOfType(MSG.USER_LIST)).toHaveLength(1)
  })
})

// ── close: settlement + backoff ──────────────────────────────────────────────

describe('close', () => {
  it('rejects pending confirmations, resets queries to loading, schedules backoff', async () => {
    const h = makeSocket()
    h.socket.registerSubscription('sub-1', QUERY_KEY)
    await h.socket.connect()
    h.ws().serverOpen()

    const confirmation = h.socket.sendConfirmed({ type: 'mutate', payload: {} })
    const rejection = expect(confirmation).rejects.toThrow('WebSocket disconnected')

    h.ws().serverDrop()
    await rejection
    expect(h.listeners.onStatus).toHaveBeenCalledWith('disconnected')
    expect(h.listeners.onReady).toHaveBeenCalledWith(false)
    expect(h.store.resetToLoading).toHaveBeenCalledWith(QUERY_KEY)

    // Backoff: first retry at 1s.
    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('backs off exponentially to the 30s ceiling and resets on USER_INFO', async () => {
    const h = makeSocket()
    await h.socket.connect()
    h.ws().serverOpen()

    // Drop repeatedly: delays 1s, 2s, 4s…
    h.ws().serverDrop()
    await vi.advanceTimersByTimeAsync(999)
    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(2)

    h.ws().serverDrop()
    await vi.advanceTimersByTimeAsync(1999)
    expect(FakeWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(3)

    // A completed handshake resets the attempt counter → next delay is 1s.
    h.ws().serverOpen()
    h.ws().serverMessage(MSG.USER_INFO, { role: 'member' })
    h.ws().serverDrop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(4)
  })

  it('server-initiated 1012 close reconnects and fully resubscribes (state-refresh)', async () => {
    // Mirrors BaseRoom.disconnectAllSockets kicking a client after an
    // out-of-band write: the close code must NOT be treated as terminal — the
    // client reconnects and re-subscribes so fresh QUERY_RESULTs replace the
    // stale store contents.
    const h = makeSocket()
    h.socket.registerSubscription('sub-1', QUERY_KEY)
    await h.socket.connect()
    h.ws().serverOpen()
    // Complete the handshake so the backoff counter is at 0 (next delay = 1s).
    h.ws().serverMessage(MSG.USER_INFO, { role: 'member' })

    h.ws().serverClose(1012, 'state-refresh')
    expect(h.store.resetToLoading).toHaveBeenCalledWith(QUERY_KEY)
    expect(FakeWebSocket.instances).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(2) // reconnected

    // The reconnected socket re-subscribes every active query on open.
    h.ws().serverOpen()
    expect(h.ws().sentOfType(MSG.SUBSCRIBE)).toHaveLength(1)
  })

  it('a clean 1000 close is NOT terminal — it still reconnects', async () => {
    // Guards against a future regression where someone special-cases
    // wasClean/1000 as "do not reconnect": a server that closes cleanly to
    // force a resync must still bring the client back.
    const h = makeSocket()
    await h.socket.connect()
    h.ws().serverOpen()

    h.ws().serverClose(1000, 'normal')
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('disconnect() cancels the scheduled reconnect and resets backoff', async () => {
    const h = makeSocket()
    await h.socket.connect()
    h.ws().serverOpen()
    h.ws().serverDrop() // schedules the 1s retry

    h.socket.disconnect()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1) // no zombie reconnect
    expect(h.listeners.onStatus).toHaveBeenLastCalledWith('connecting')
  })

  it('destroy() tears down without touching listeners (owner unmounted)', async () => {
    const h = makeSocket()
    await h.socket.connect()
    h.ws().serverOpen()
    h.listeners.onStatus.mockClear()

    h.socket.destroy()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(h.listeners.onStatus).not.toHaveBeenCalled()
    // and it stays dead
    await h.socket.connect()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

// ── confirmations ────────────────────────────────────────────────────────────

describe('sendConfirmed', () => {
  it('resolves on ACK success with the extra payload', async () => {
    const h = makeSocket()
    await h.socket.connect()
    h.ws().serverOpen()

    const promise = h.socket.sendConfirmed({ type: 'mutate', payload: { a: 1 } })
    const sent = JSON.parse(h.ws().sent.at(-1)!) as { payload: { requestId: string } }
    h.ws().serverMessage(MSG.ACK, { requestId: sent.payload.requestId, success: true, recordId: 'r1' })
    await expect(promise).resolves.toEqual({ recordId: 'r1' })
  })

  it('rejects on ACK failure with the server error', async () => {
    const h = makeSocket()
    await h.socket.connect()
    h.ws().serverOpen()

    const promise = h.socket.sendConfirmed({ type: 'mutate', payload: {} })
    const sent = JSON.parse(h.ws().sent.at(-1)!) as { payload: { requestId: string } }
    h.ws().serverMessage(MSG.ACK, { requestId: sent.payload.requestId, success: false, error: 'denied' })
    await expect(promise).rejects.toThrow('denied')
  })

  it('times out when no ACK arrives', async () => {
    const h = makeSocket()
    await h.socket.connect()
    h.ws().serverOpen()

    const promise = h.socket.sendConfirmed({ type: 'mutate', payload: {} }, 5000)
    const rejection = expect(promise).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(5000)
    await rejection
  })

  it('rejects immediately when not connected', async () => {
    const h = makeSocket()
    await expect(h.socket.sendConfirmed({ type: 'mutate', payload: {} })).rejects.toThrow(
      'not connected',
    )
  })
})

// ── message dispatch ─────────────────────────────────────────────────────────

describe('dispatch', () => {
  async function openSocket() {
    const h = makeSocket()
    h.socket.registerSubscription('sub-1', QUERY_KEY)
    await h.socket.connect()
    h.ws().serverOpen()
    return h
  }

  it('QUERY_RESULT lands in the store under the subscription queryKey', async () => {
    const h = await openSocket()
    h.ws().serverMessage(MSG.QUERY_RESULT, { subscriptionId: 'sub-1', records: [{ recordId: 'r1' }] })
    expect(h.store.setQueryResult).toHaveBeenCalledWith(QUERY_KEY, [{ recordId: 'r1' }])
  })

  it('RECORD_CHANGE: an update that stops matching the where becomes a delete', async () => {
    const h = await openSocket()
    h.store.hasRecord.mockReturnValue(true)
    h.ws().serverMessage(MSG.RECORD_CHANGE, {
      collection: 'todos',
      record: { recordId: 'r1', data: { done: true } }, // where is { done: false }
      changeType: 'update',
    })
    expect(h.store.applyChange).toHaveBeenCalledWith(
      QUERY_KEY,
      { recordId: 'r1', data: { done: true } },
      'delete',
    )
  })

  it('ERROR with a subscriptionId sets the query error; a bare permission error hits the callback', async () => {
    const h = await openSocket()
    h.ws().serverMessage(MSG.ERROR, { subscriptionId: 'sub-1', error: 'boom' })
    expect(h.store.setError).toHaveBeenCalledWith(QUERY_KEY, 'boom')

    h.ws().serverMessage(MSG.ERROR, { error: 'CREATE DENIED: role=viewer, collection=todos' })
    expect(h.listeners.onPermissionError).toHaveBeenCalled()
  })

  it('RESUBSCRIBE re-sends every active subscription', async () => {
    const h = await openSocket()
    const before = h.ws().sentOfType(MSG.SUBSCRIBE).length
    h.ws().serverMessage(MSG.RESUBSCRIBE, {})
    expect(h.ws().sentOfType(MSG.SUBSCRIBE).length).toBe(before + 1)
  })

  it('LIST_SCHEMAS reaches the onSchemas listener', async () => {
    const h = await openSocket()
    h.ws().serverMessage(MSG.LIST_SCHEMAS, { schemas: [{ name: 'todos' }] })
    expect(h.listeners.onSchemas).toHaveBeenCalledWith([{ name: 'todos' }])
  })

  it('binary frames fan out to binary handlers; YJS_JOIN reaches its doc handler', async () => {
    const h = await openSocket()
    const binary = vi.fn()
    h.socket.onBinaryMessage(binary)
    const buffer = new ArrayBuffer(4)
    h.ws().onmessage?.({ data: buffer })
    expect(binary).toHaveBeenCalledWith(buffer)

    const join = vi.fn()
    h.socket.registerYjsJoinHandler('todos:r1:body', join)
    h.ws().serverMessage(MSG.YJS_JOIN, {
      collection: 'todos',
      recordId: 'r1',
      fieldName: 'body',
      canWrite: true,
    })
    expect(join).toHaveBeenCalledWith(true)
  })

  it('unregistered subscriptions receive nothing', async () => {
    const h = await openSocket()
    h.socket.unregisterSubscription('sub-1')
    h.ws().serverMessage(MSG.QUERY_RESULT, { subscriptionId: 'sub-1', records: [] })
    expect(h.store.setQueryResult).not.toHaveBeenCalled()
  })
})
