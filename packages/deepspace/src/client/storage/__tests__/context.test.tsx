// @vitest-environment jsdom
/**
 * Provider-layer wiring tests for the onWriteError pipeline.
 *
 * The socket → parseServerError → listener edge was always covered by
 * record-socket.test.ts, but the seam ABOVE it — public RecordProvider prop
 * → context/refs → socket listeners — shipped as dead code for months
 * because nothing rendered the providers and asserted the prop actually
 * received an error. These tests pin that seam in both provider modes, plus
 * the signed-out diagnostic and the deduped console.error default.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { RecordProvider, __resetDevWarningsForTests, type WriteError } from '../context'
import { RecordScope } from '../RecordScope'

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

// ── Tests ────────────────────────────────────────────────────────────────

describe('RecordProvider onWriteError wiring', () => {
  it('single-scope mode: a socket permission error reaches the public prop', async () => {
    const spy = vi.fn<(e: WriteError) => void>()
    await render(
      <RecordProvider roomId="app:test" allowAnonymous onWriteError={spy}>
        <div data-testid="child" />
      </RecordProvider>,
    )
    expect(container.querySelector('[data-testid="child"]')).toBeTruthy()
    expect(sockets.all.length).toBeGreaterThan(0)

    sockets.all[0].listeners.onPermissionError?.("Viewers can't edit Tasks", '')
    expect(spy).toHaveBeenCalledWith({
      kind: 'permission',
      title: "Viewers can't edit Tasks",
      detail: '',
    })

    sockets.all[0].listeners.onValidationError?.('Missing field', '"title" is required')
    expect(spy).toHaveBeenCalledWith({
      kind: 'validation',
      title: 'Missing field',
      detail: '"title" is required',
    })
  })

  it('multi-scope mode: a RecordScope socket error reaches the provider prop', async () => {
    const spy = vi.fn<(e: WriteError) => void>()
    await render(
      <RecordProvider allowAnonymous onWriteError={spy}>
        <RecordScope roomId="app:test" schemas={[]} appId="test">
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
  })

  it('default handler console.errors once per unique error (deduped)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await render(
      <RecordProvider roomId="app:test" allowAnonymous>
        <div />
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

describe('signed-out diagnostic', () => {
  it('renders the diagnostic instead of children when signed out without allowAnonymous (local dev)', async () => {
    ;(globalThis as Record<string, unknown>).DEEPSPACE_DEV = true
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await render(
      <RecordProvider roomId="app:test">
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
      <RecordProvider roomId="app:test">
        <div data-testid="child" />
      </RecordProvider>,
    )
    expect(container.querySelector('[data-deepspace-diagnostic="signed-out"]')).toBeNull()
    expect(container.querySelector('[data-testid="child"]')).toBeNull()
    expect(container.textContent).toBe('')
  })
})
