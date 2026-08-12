// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAuthToken } from '../../../auth'
import { useRecordAuth } from '../../context'
import { usePresenceRoom } from '../usePresenceRoom'
import { encode, serverBuild } from '../../../../shared/protocol/messages'

vi.mock('../../../auth', () => ({ getAuthToken: vi.fn() }))
vi.mock('../../context', () => ({ useRecordAuth: vi.fn() }))
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const defaultToken = vi.mocked(getAuthToken)
const recordAuth = vi.mocked(useRecordAuth)
const providerToken = vi.fn<() => Promise<string | null>>()

let container: HTMLDivElement
let root: Root
let openedUrls: string[]
let sockets: FakeWebSocket[]

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState = FakeWebSocket.OPEN
  closeCalls = 0
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    openedUrls.push(url)
    sockets.push(this)
  }

  send() {}
  close() {
    this.closeCalls++
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }
}

function Probe() {
  const { connected, peers } = usePresenceRoom('minimal-presence-repro')
  return <output data-connected={String(connected)}>{peers.length}</output>
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  openedUrls = []
  sockets = []
  defaultToken.mockReset()
  providerToken.mockReset()
  recordAuth.mockReset()
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('usePresenceRoom auth', () => {
  it('uses the provider token callback so anonymous rooms do not probe /api/auth/token', async () => {
    providerToken.mockResolvedValue(null)
    defaultToken.mockResolvedValue('unexpected-global-token')
    recordAuth.mockReturnValue({ getAuthToken: providerToken } as never)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })

    expect(providerToken).toHaveBeenCalledOnce()
    expect(defaultToken).not.toHaveBeenCalled()
    expect(openedUrls).toEqual(['ws://localhost:3000/ws/presence/minimal-presence-repro'])
  })

  it('keeps the standalone global-token fallback outside RecordProvider', async () => {
    defaultToken.mockResolvedValue('standalone-token')
    recordAuth.mockReturnValue(null)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })

    expect(defaultToken).toHaveBeenCalledOnce()
    expect(providerToken).not.toHaveBeenCalled()
    expect(openedUrls).toEqual([
      'ws://localhost:3000/ws/presence/minimal-presence-repro?token=standalone-token',
    ])
  })

  it('does not open a stale socket when the provider changes during token lookup', async () => {
    let resolveFirst: ((token: string | null) => void) | undefined
    const firstToken = vi.fn(
      () => new Promise<string | null>((resolve) => (resolveFirst = resolve)),
    )
    const secondToken = vi.fn(async () => null)
    recordAuth.mockReturnValue({ getAuthToken: firstToken } as never)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    expect(firstToken).toHaveBeenCalledOnce()

    recordAuth.mockReturnValue({ getAuthToken: secondToken } as never)
    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    expect(openedUrls).toEqual(['ws://localhost:3000/ws/presence/minimal-presence-repro'])

    await act(async () => {
      resolveFirst?.('stale-token')
      await Promise.resolve()
    })
    expect(openedUrls).toEqual(['ws://localhost:3000/ws/presence/minimal-presence-repro'])
  })

  it('clears the prior connection and peers while replacement auth is pending', async () => {
    providerToken.mockResolvedValue('first-token')
    recordAuth.mockReturnValue({ getAuthToken: providerToken } as never)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    await act(async () => {
      sockets[0]?.onopen?.()
      sockets[0]?.onmessage?.(
        new MessageEvent('message', {
          data: encode(
            serverBuild.presenceSync([
              {
                userId: 'peer',
                userName: 'Peer',
                joinedAt: '2026-08-10T00:00:00.000Z',
                state: {},
              },
            ]),
          ),
        }),
      )
    })
    expect(container.querySelector('output')?.dataset.connected).toBe('true')
    expect(container.querySelector('output')?.textContent).toBe('1')

    const pendingToken = vi.fn(() => new Promise<string | null>(() => {}))
    recordAuth.mockReturnValue({ getAuthToken: pendingToken } as never)
    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })

    expect(container.querySelector('output')?.dataset.connected).toBe('false')
    expect(container.querySelector('output')?.textContent).toBe('0')
  })

  it('reports offline immediately and reconnects once when the browser returns online', async () => {
    providerToken.mockResolvedValue(null)
    recordAuth.mockReturnValue({ getAuthToken: providerToken } as never)

    await act(async () => {
      root.render(<Probe />)
      await Promise.resolve()
    })
    await act(async () => sockets[0]?.onopen?.())
    expect(container.querySelector('output')?.dataset.connected).toBe('true')

    await act(async () => window.dispatchEvent(new Event('offline')))
    expect(container.querySelector('output')?.dataset.connected).toBe('false')
    expect(sockets[0]?.closeCalls).toBe(1)

    await act(async () => {
      window.dispatchEvent(new Event('online'))
      window.dispatchEvent(new Event('online'))
      await Promise.resolve()
    })
    expect(sockets).toHaveLength(2)
    expect(providerToken).toHaveBeenCalledTimes(2)

    await act(async () => sockets[1]?.onopen?.())
    expect(container.querySelector('output')?.dataset.connected).toBe('true')
  })
})
