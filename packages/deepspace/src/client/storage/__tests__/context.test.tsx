// @vitest-environment jsdom
/**
 * Provider-layer wiring tests for the onWriteError pipeline.
 *
 * The socket → parseServerError → listener edge was always covered by
 * record-socket.test.ts, but the seam ABOVE it — public RecordProvider prop
 * → context/refs → socket listeners — shipped as dead code for months
 * because nothing rendered the provider and asserted the prop actually
 * received an error. These tests pin that seam through RecordScope, plus the
 * signed-out diagnostic and the deduplicated console.error default.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { RecordProvider, __resetDevWarningsForTests } from '../context'
import { RecordScope } from '../RecordScope'
import { RecordRoomNotReadyError } from '../errors'
import { useMutations } from '../hooks/useMutations'
import type { WriteError } from '../types'
import type { CollectionSchema } from '../../../shared/types'
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// ── Mocks ────────────────────────────────────────────────────────────────

const authState = vi.hoisted(() => ({ isLoaded: true, isSignedIn: false }))
vi.mock('../../auth', () => ({
  useAuth: () => ({
    isLoaded: authState.isLoaded,
    isSignedIn: authState.isSignedIn,
    userId: null,
    sessionId: null,
  }),
  getAuthToken: async () => null,
}))

interface SocketListeners {
  onPermissionError?: (title: string, detail: string) => void
  onValidationError?: (title: string, detail: string) => void
}
const sockets = vi.hoisted(() => ({ all: [] as Array<{ listeners: SocketListeners }> }))
vi.mock('../record-socket', () => {
  class RecordSocket {
    listeners: SocketListeners
    constructor(opts: { listeners: SocketListeners }) {
      this.listeners = opts.listeners
      sockets.all.push(this)
    }
    connect = async () => {}
    destroy = () => {}
    resetBackoff = () => {}
    sendMessage = () => {}
    sendBinary = () => {}
    sendConfirmed = async () => ({})
    get isOpen() {
      return false
    }
  }
  return { RecordSocket }
})

// ── Harness ──────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root

async function render(ui: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(ui)
  })
  // Flush the fetchUser promise so userProfileLoading settles and the
  // socket-creating effect re-runs.
  await act(async () => {})
}

beforeEach(() => {
  __resetDevWarningsForTests()
  sockets.all.length = 0
  authState.isLoaded = true
  authState.isSignedIn = false
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  delete (globalThis as Record<string, unknown>).DEEPSPACE_DEV
  vi.restoreAllMocks()
})

const tasksSchema: CollectionSchema = {
  name: 'tasks',
  columns: [{ name: 'title', storage: 'text', interpretation: 'text' }],
  permissions: {},
}

let mutations: ReturnType<typeof useMutations<{ title: string }>> | null = null
function MutationProbe(): null {
  mutations = useMutations<{ title: string }>('tasks')
  return null
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('RecordProvider onWriteError wiring', () => {
  it('a RecordScope socket error reaches the provider prop', async () => {
    const spy = vi.fn<(e: WriteError) => void>()
    await render(
      <RecordProvider allowAnonymous onWriteError={spy}>
        <RecordScope roomId="app:test" schemas={[]}>
          <div />
        </RecordScope>
      </RecordProvider>,
    )
    expect(sockets.all.length).toBeGreaterThan(0)

    sockets.all[0].listeners.onValidationError?.('Error', 'raw server string')
    expect(spy).toHaveBeenCalledWith({
      kind: 'validation',
      title: 'Error',
      detail: 'raw server string',
    })

    sockets.all[0].listeners.onPermissionError?.("Viewers can't edit Tasks", '')
    expect(spy).toHaveBeenCalledWith({
      kind: 'permission',
      title: "Viewers can't edit Tasks",
      detail: '',
    })
  })

  it('default handler console.errors once per unique error (deduped)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await render(
      <RecordProvider allowAnonymous>
        <RecordScope roomId="app:test" schemas={[]}>
          <div />
        </RecordScope>
      </RecordProvider>,
    )
    const fire = () => sockets.all[0].listeners.onPermissionError?.('Denied', 'same detail')
    fire()
    fire()
    fire()
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0][0])).toContain('Pass onWriteError to <RecordProvider>')

    sockets.all[0].listeners.onPermissionError?.('Denied', 'different detail')
    expect(errorSpy).toHaveBeenCalledTimes(2)
  })
})

describe('not-ready writes reach onWriteError', () => {
  /**
   * The hole this pins: a mutation fired before the room accepts writes fails
   * entirely client-side (no socket involved), so before the fix it reached
   * `onWriteError` — the documented surface for write failures — never.
   */
  it('a write attempted before the room is ready reaches the provider prop', async () => {
    const spy = vi.fn<(e: WriteError) => void>()
    mutations = null
    await render(
      <RecordProvider allowAnonymous onWriteError={spy}>
        <RecordScope roomId="app:test" schemas={[tasksSchema]}>
          <MutationProbe />
        </RecordScope>
      </RecordProvider>,
    )
    expect(mutations!.ready).toBe(false)

    // Still rejects: callers that await keep their existing contract.
    await expect(mutations!.create({ title: 'too soon' })).rejects.toBeInstanceOf(
      RecordRoomNotReadyError,
    )

    expect(spy).toHaveBeenCalledTimes(1)
    const error = spy.mock.calls[0][0]
    expect(error.kind).toBe('not_ready')
    expect(error.detail).toContain('tasks')
    expect(error.detail).toContain('ready')
  })

  it('every mutation entry point dispatches, including the confirmed variants', async () => {
    const spy = vi.fn<(e: WriteError) => void>()
    mutations = null
    await render(
      <RecordProvider allowAnonymous onWriteError={spy}>
        <RecordScope roomId="app:test" schemas={[tasksSchema]}>
          <MutationProbe />
        </RecordScope>
      </RecordProvider>,
    )

    const attempts = [
      mutations!.create({ title: 'a' }),
      mutations!.put('t1', { title: 'b' }),
      mutations!.remove('t1'),
      mutations!.createConfirmed({ title: 'c' }),
      mutations!.putConfirmed('t1', { title: 'd' }),
      mutations!.removeConfirmed('t1'),
    ]
    for (const attempt of attempts) {
      await expect(attempt).rejects.toBeInstanceOf(RecordRoomNotReadyError)
    }
    expect(spy).toHaveBeenCalledTimes(attempts.length)
    expect(spy.mock.calls.every(([e]) => e.kind === 'not_ready')).toBe(true)
  })

  it('the default handler covers not-ready writes when no onWriteError is passed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mutations = null
    await render(
      <RecordProvider allowAnonymous>
        <RecordScope roomId="app:test" schemas={[tasksSchema]}>
          <MutationProbe />
        </RecordScope>
      </RecordProvider>,
    )

    await expect(mutations!.create({ title: 'too soon' })).rejects.toBeInstanceOf(
      RecordRoomNotReadyError,
    )
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0][0])).toContain('Pass onWriteError to <RecordProvider>')
  })
})

describe('signed-out diagnostic', () => {
  it('renders the diagnostic instead of children when signed out without allowAnonymous (local dev)', async () => {
    ;(globalThis as Record<string, unknown>).DEEPSPACE_DEV = true
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await render(
      <RecordProvider>
        <div data-testid="child" />
      </RecordProvider>,
    )
    expect(container.querySelector('[data-deepspace-diagnostic="signed-out"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="child"]')).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('DEEPSPACE_DEV=false suppresses the diagnostic (renders nothing, as in production)', async () => {
    // jsdom serves from localhost, so this specifically proves the escape hatch.
    ;(globalThis as Record<string, unknown>).DEEPSPACE_DEV = false
    await render(
      <RecordProvider>
        <div data-testid="child" />
      </RecordProvider>,
    )
    expect(container.querySelector('[data-deepspace-diagnostic="signed-out"]')).toBeNull()
    expect(container.querySelector('[data-testid="child"]')).toBeNull()
    expect(container.textContent).toBe('')
  })
})
