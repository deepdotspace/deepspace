// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { RecordSocket, type RecordSocketConfig } from '../record-socket'

function socketUrl(config: Partial<RecordSocketConfig>): Promise<string> {
  return new Promise((resolve) => {
    class CapturingWebSocket {
      readyState = 0
      binaryType = 'blob'
      constructor(url: string) {
        resolve(url)
      }
      close() {}
      send() {}
    }
    const socket = new RecordSocket({
      roomId: 'app:test',
      store: { resetToLoading: vi.fn() } as unknown as RecordSocketConfig['store'],
      getToken: async () => 'jwt',
      listeners: {
        onStatus: vi.fn(),
        onReady: vi.fn(),
        onRole: vi.fn(),
        onUsers: vi.fn(),
      },
      WebSocketImpl: CapturingWebSocket as unknown as typeof WebSocket,
      ...config,
    })
    void socket.connect()
  })
}

describe('RecordSocket base URL', () => {
  it('defaults to the page origin with the matching ws scheme', async () => {
    const expected = `${window.location.origin.replace(/^http/, 'ws')}/ws/app:test?token=jwt`
    await expect(socketUrl({})).resolves.toBe(expected)
  })

  it('maps an explicit https base to wss and keeps an explicit ws base', async () => {
    await expect(socketUrl({ wsUrl: 'https://tasks.app.space' })).resolves.toBe(
      'wss://tasks.app.space/ws/app:test?token=jwt',
    )
    await expect(socketUrl({ wsUrl: 'ws://localhost:5173', wsPathPrefix: '/rt' })).resolves.toBe(
      'ws://localhost:5173/rt/app:test?token=jwt',
    )
  })

  it('never reads window.location when a base is supplied', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'location')
    // React Native defines `window` without `location`.
    Object.defineProperty(window, 'location', { configurable: true, get: () => undefined })
    try {
      await expect(socketUrl({ wsUrl: 'https://tasks.app.space' })).resolves.toBe(
        'wss://tasks.app.space/ws/app:test?token=jwt',
      )
    } finally {
      if (original) Object.defineProperty(window, 'location', original)
    }
  })
})
