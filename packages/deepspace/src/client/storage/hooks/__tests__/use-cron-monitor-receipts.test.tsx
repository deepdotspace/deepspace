// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAuthToken } from '../../../auth'
import {
  useCronMonitor,
  type CronMutationResult,
  type UseCronMonitorResult,
} from '../useCronMonitor'
import { MSG } from '../../../../shared/protocol/constants'
import { encode, serverBuild } from '../../../../shared/protocol/messages'

vi.mock('../../../auth', () => ({ getAuthToken: vi.fn() }))
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const token = vi.mocked(getAuthToken)

let container: HTMLDivElement
let root: Root
let sockets: FakeWebSocket[]
let hook: UseCronMonitorResult | undefined

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState = FakeWebSocket.OPEN
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(_url: string) {
    sockets.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }
}

function Probe() {
  hook = useCronMonitor('cron')
  return <output data-canwrite={String(hook.canWrite)}>{hook.lastError ?? ''}</output>
}

/** Mount the probe, open its socket, and deliver the AUTH frame. */
async function mount(canWrite: boolean): Promise<FakeWebSocket> {
  await act(async () => {
    root.render(<Probe />)
    await Promise.resolve()
  })
  const socket = sockets[0]!
  await act(async () => {
    socket.onopen?.()
    socket.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({ type: MSG.AUTH, payload: { canWrite } }),
      }),
    )
  })
  return socket
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  sockets = []
  hook = undefined
  token.mockReset()
  token.mockResolvedValue(null)
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('useCronMonitor mutation receipts', () => {
  it('resolves read_only for a viewer without sending a frame', async () => {
    const socket = await mount(false)

    let result: CronMutationResult | undefined
    await act(async () => {
      result = await hook!.trigger('heartbeat')
    })

    expect(result).toEqual({ ok: false, reason: 'read_only' })
    expect(socket.sent).toEqual([])
  })

  it('resolves a connected trigger on the CRON_ACK receipt', async () => {
    const socket = await mount(true)

    let pending: Promise<CronMutationResult> | undefined
    await act(async () => {
      pending = hook!.trigger('heartbeat')
    })

    expect(socket.sent).toHaveLength(1)
    const frame = JSON.parse(socket.sent[0]!) as {
      type: string
      payload: { taskName: string; requestId?: string }
    }
    expect(frame.type).toBe(MSG.CRON_TRIGGER)
    expect(frame.payload.taskName).toBe('heartbeat')
    expect(frame.payload.requestId).toEqual(expect.any(String))

    await act(async () => {
      socket.onmessage?.(
        new MessageEvent('message', {
          data: encode(serverBuild.cronAckSuccess(frame.payload.requestId!, 'heartbeat')),
        }),
      )
    })

    await expect(pending).resolves.toEqual({
      ok: true,
      taskName: 'heartbeat',
      requestId: frame.payload.requestId,
    })
  })

  it('drains pending mutations with not_connected when the socket closes', async () => {
    const socket = await mount(true)

    let pending: Promise<CronMutationResult> | undefined
    await act(async () => {
      pending = hook!.trigger('heartbeat')
    })
    expect(socket.sent).toHaveLength(1)

    await act(async () => socket.close())

    await expect(pending).resolves.toEqual({ ok: false, reason: 'not_connected' })
  })

  it('surfaces server ERROR frames as lastError', async () => {
    const socket = await mount(true)

    await act(async () => {
      socket.onmessage?.(
        new MessageEvent('message', {
          data: encode(serverBuild.error('Unknown cron task: nope')),
        }),
      )
    })

    expect(container.querySelector('output')?.textContent).toBe('Unknown cron task: nope')
  })
})
