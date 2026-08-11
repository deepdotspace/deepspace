// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MSG_YJS_SYNC } from '@/shared/protocol/constants'
import {
  Awareness,
  MSG_AWARENESS,
  MSG_SYNC,
  MSG_SYNC_STEP1,
  MSG_SYNC_STEP2,
  MSG_SYNC_UPDATE,
  createDecoder,
  createEncoder,
  handleAwarenessMessage,
  readVarUint,
  readVarUint8Array,
  toUint8Array,
  writeVarUint,
  writeVarUint8Array,
} from '@/shared/protocol/yjs'
import { useYjsField, useYjsText, type UseYjsFieldResult, type UseYjsTextResult } from '../useYjs'
import { useYjsRoom, type UseYjsRoomResult } from '../useYjsRoom'
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const recordHarness = vi.hoisted(() => {
  const binaryHandlers = new Set<(data: ArrayBuffer) => void>()
  const joinHandlers = new Map<string, (canWrite: boolean) => void>()

  return {
    binaryHandlers,
    joinHandlers,
    context: {
      ready: true,
      sendMessage: vi.fn(),
      sendBinary: vi.fn(),
      onBinaryMessage: vi.fn((handler: (data: ArrayBuffer) => void) => {
        binaryHandlers.add(handler)
        return () => binaryHandlers.delete(handler)
      }),
      registerYjsJoinHandler: vi.fn((docKey: string, handler: (canWrite: boolean) => void) => {
        joinHandlers.set(docKey, handler)
        return () => {
          if (joinHandlers.get(docKey) === handler) joinHandlers.delete(docKey)
        }
      }),
    },
  }
})

vi.mock('../../context', () => ({
  useRecordContext: () => recordHarness.context,
}))

vi.mock('../../../auth', () => ({
  getAuthToken: async () => null,
}))

type BinaryPayload = ArrayBufferLike | ArrayBufferView

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static readonly instances: FakeWebSocket[] = []
  static autoOpen = true

  readonly url: string
  readonly sent: BinaryPayload[] = []
  binaryType = ''
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      if (FakeWebSocket.autoOpen) this.open()
    })
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === 'string') throw new Error('Yjs hook unexpectedly sent a text frame')
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }

  open(): void {
    if (this.readyState !== FakeWebSocket.CONNECTING) return
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  receive(data: string | ArrayBuffer): void {
    this.onmessage?.({ data })
  }
}

let container: HTMLDivElement
let root: Root
let roomResult: UseYjsRoomResult | null = null
let fieldResult: UseYjsFieldResult | null = null
let textResult: UseYjsTextResult | null = null

function RoomProbe({ docId, fieldName = 'content' }: { docId: string; fieldName?: string }) {
  roomResult = useYjsRoom(docId, fieldName)
  return null
}

function FieldProbe({ recordId }: { recordId: string }) {
  fieldResult = useYjsField('documents', recordId, 'content')
  return null
}

function TextProbe({ recordId }: { recordId: string }) {
  textResult = useYjsText('documents', recordId, 'content')
  return null
}

async function render(ui: ReactElement): Promise<void> {
  await act(async () => {
    root.render(ui)
    await Promise.resolve()
  })
}

function encodeRoomStep1(): ArrayBuffer {
  const serverDoc = new Y.Doc()
  const encoder = createEncoder()
  writeVarUint(encoder, MSG_SYNC)
  writeVarUint(encoder, MSG_SYNC_STEP1)
  writeVarUint8Array(encoder, Y.encodeStateVector(serverDoc))
  serverDoc.destroy()
  return toUint8Array(encoder).buffer as ArrayBuffer
}

function encodeFieldStep1(docKey: string): ArrayBuffer {
  const serverDoc = new Y.Doc()
  const encoder = createEncoder()
  writeVarUint(encoder, MSG_YJS_SYNC)
  writeVarUint8Array(encoder, new TextEncoder().encode(docKey))
  writeVarUint(encoder, MSG_SYNC_STEP1)
  writeVarUint8Array(encoder, Y.encodeStateVector(serverDoc))
  serverDoc.destroy()
  return toUint8Array(encoder).buffer as ArrayBuffer
}

function encodeFieldStep2(docKey: string, text: string): ArrayBuffer {
  const serverDoc = new Y.Doc()
  serverDoc.getText('content').insert(0, text)
  const encoder = createEncoder()
  writeVarUint(encoder, MSG_YJS_SYNC)
  writeVarUint8Array(encoder, new TextEncoder().encode(docKey))
  writeVarUint(encoder, MSG_SYNC_STEP2)
  writeVarUint8Array(encoder, Y.encodeStateAsUpdate(serverDoc))
  serverDoc.destroy()
  return toUint8Array(encoder).buffer as ArrayBuffer
}

function toBytes(data: BinaryPayload): Uint8Array {
  return ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data)
}

function roomReplyText(data: BinaryPayload): string {
  const bytes = toBytes(data)
  const decoder = createDecoder(bytes)
  expect(readVarUint(decoder)).toBe(MSG_SYNC)
  expect(readVarUint(decoder)).toBe(MSG_SYNC_STEP2)
  const probe = new Y.Doc()
  Y.applyUpdate(probe, readVarUint8Array(decoder))
  const text = probe.getText('content').toString()
  probe.destroy()
  return text
}

function roomUpdateText(data: BinaryPayload): string {
  const bytes = toBytes(data)
  const decoder = createDecoder(bytes)
  expect(readVarUint(decoder)).toBe(MSG_SYNC)
  expect(readVarUint(decoder)).toBe(MSG_SYNC_UPDATE)
  const probe = new Y.Doc()
  Y.applyUpdate(probe, readVarUint8Array(decoder))
  const text = probe.getText('content').toString()
  probe.destroy()
  return text
}

function awarenessEntry(data: BinaryPayload): {
  clientId: number
  clock: number
  state: Record<string, unknown> | null
} {
  const decoder = createDecoder(toBytes(data))
  expect(readVarUint(decoder)).toBe(MSG_AWARENESS)
  const updateDecoder = createDecoder(readVarUint8Array(decoder))
  expect(readVarUint(updateDecoder)).toBe(1)
  const clientId = readVarUint(updateDecoder)
  const clock = readVarUint(updateDecoder)
  const stateJson = new TextDecoder().decode(readVarUint8Array(updateDecoder))
  return {
    clientId,
    clock,
    state: stateJson === 'null' ? null : (JSON.parse(stateJson) as Record<string, unknown>),
  }
}

function encodeAwarenessTombstone(clientId: number, clock: number): ArrayBuffer {
  const update = createEncoder()
  writeVarUint(update, 1)
  writeVarUint(update, clientId)
  writeVarUint(update, clock)
  writeVarUint8Array(update, new TextEncoder().encode('null'))

  const message = createEncoder()
  writeVarUint(message, MSG_AWARENESS)
  writeVarUint8Array(message, toUint8Array(update))
  return toUint8Array(message).buffer as ArrayBuffer
}

function fieldReplyText(data: BinaryPayload, expectedKey: string): string {
  const bytes = toBytes(data)
  const decoder = createDecoder(bytes)
  expect(readVarUint(decoder)).toBe(MSG_YJS_SYNC)
  expect(new TextDecoder().decode(readVarUint8Array(decoder))).toBe(expectedKey)
  expect(readVarUint(decoder)).toBe(MSG_SYNC_STEP2)
  const probe = new Y.Doc()
  Y.applyUpdate(probe, readVarUint8Array(decoder))
  const text = probe.getText('content').toString()
  probe.destroy()
  return text
}

beforeEach(() => {
  roomResult = null
  fieldResult = null
  textResult = null
  FakeWebSocket.instances.length = 0
  FakeWebSocket.autoOpen = true
  recordHarness.binaryHandlers.clear()
  recordHarness.joinHandlers.clear()
  for (const mock of Object.values(recordHarness.context)) {
    if (typeof mock === 'function' && 'mockClear' in mock) mock.mockClear()
  }
  vi.stubGlobal('WebSocket', FakeWebSocket)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('Yjs document identity ownership', () => {
  it('useYjsRoom cannot answer room B sync with room A state and destroys A resources', async () => {
    await render(<RoomProbe docId="room-a" />)
    const resultA = roomResult!
    const destroyedA = vi.fn()
    resultA.doc.on('destroy', destroyedA)
    resultA.awareness.setLocalState({ cursor: 'room-a' })
    resultA.doc.getText('content').insert(0, 'room A secret')

    await render(<RoomProbe docId="room-b" />)
    const resultB = roomResult!

    expect(resultB.doc).not.toBe(resultA.doc)
    expect(resultB.awareness).not.toBe(resultA.awareness)
    expect(resultB.doc.getText('content').toString()).toBe('')
    expect(destroyedA).toHaveBeenCalledOnce()
    expect(resultA.awareness.getStates().size).toBe(0)

    const socketB = FakeWebSocket.instances.at(-1)!
    expect(socketB.url).toContain('/ws/yjs/room-b')
    resultA.awareness.setLocalState({ cursor: 'stale-room-a' })
    expect(socketB.sent).toHaveLength(0)
    await act(async () => socketB.receive(encodeRoomStep1()))

    expect(socketB.sent).toHaveLength(1)
    expect(roomReplyText(socketB.sent[0])).toBe('')
  })

  it('useYjsField cannot answer field B sync with field A state and destroys A resources', async () => {
    await render(<FieldProbe recordId="record-a" />)
    const resultA = fieldResult!
    const destroyedA = vi.fn()
    resultA.doc.on('destroy', destroyedA)
    resultA.awareness.setLocalState({ cursor: 'record-a' })
    resultA.doc.getText('content').insert(0, 'record A secret')

    await render(<FieldProbe recordId="record-b" />)
    const resultB = fieldResult!

    expect(resultB.doc).not.toBe(resultA.doc)
    expect(resultB.awareness).not.toBe(resultA.awareness)
    expect(resultB.doc.getText('content').toString()).toBe('')
    expect(destroyedA).toHaveBeenCalledOnce()
    expect(resultA.awareness.getStates().size).toBe(0)
    expect(recordHarness.binaryHandlers.size).toBe(1)

    recordHarness.context.sendBinary.mockClear()
    resultA.awareness.setLocalState({ cursor: 'stale-record-a' })
    expect(recordHarness.context.sendBinary).not.toHaveBeenCalled()
    const docKeyB = 'documents:record-b:content'
    await act(async () => {
      for (const handler of recordHarness.binaryHandlers) handler(encodeFieldStep1(docKeyB))
    })

    expect(recordHarness.context.sendBinary).toHaveBeenCalledOnce()
    expect(fieldReplyText(recordHarness.context.sendBinary.mock.calls[0][0], docKeyB)).toBe('')
  })

  it('useYjsText hides A text immediately and hydrates from B sync', async () => {
    const docKeyA = 'documents:record-a:content'
    await render(<TextProbe recordId="record-a" />)
    await act(async () => recordHarness.joinHandlers.get(docKeyA)?.(true))
    await act(async () => textResult!.setText('record A text'))
    expect(textResult!.text).toBe('record A text')

    await render(<TextProbe recordId="record-b" />)
    expect(textResult!.text).toBe('')
    expect(textResult!.synced).toBe(false)

    const docKeyB = 'documents:record-b:content'
    await act(async () => {
      for (const handler of recordHarness.binaryHandlers) {
        handler(encodeFieldStep2(docKeyB, 'record B text'))
      }
    })

    expect(textResult!.synced).toBe(true)
    expect(textResult!.text).toBe('record B text')
  })
})

describe('useYjsRoom transport behavior', () => {
  it('reports transport connectivity and reconnects when the browser returns online', async () => {
    await render(<RoomProbe docId="room-online-state" />)
    const firstSocket = FakeWebSocket.instances.at(-1)!
    expect(roomResult!.connected).toBe(true)

    await act(async () => window.dispatchEvent(new Event('offline')))
    expect(firstSocket.readyState).toBe(FakeWebSocket.CLOSED)
    expect(roomResult!.connected).toBe(false)
    expect(roomResult!.synced).toBe(false)

    await act(async () => {
      window.dispatchEvent(new Event('online'))
      await Promise.resolve()
    })
    expect(FakeWebSocket.instances.at(-1)).not.toBe(firstSocket)
    expect(roomResult!.connected).toBe(true)
  })

  it('distinguishes unresolved write auth from a resolved read-only role', async () => {
    await render(<RoomProbe docId="room-auth" />)
    expect(roomResult!.canWrite).toBe(false)
    expect(roomResult!.writeAuthResolved).toBe(false)

    const socket = FakeWebSocket.instances.at(-1)!
    await act(async () => socket.receive(JSON.stringify({ type: 'auth', canWrite: false })))

    expect(roomResult!.canWrite).toBe(false)
    expect(roomResult!.writeAuthResolved).toBe(true)

    await render(<RoomProbe docId="room-auth-next" />)
    expect(roomResult!.writeAuthResolved).toBe(false)
  })

  it('fails write permission closed while a replacement socket authenticates', async () => {
    vi.useFakeTimers()
    try {
      await render(<RoomProbe docId="room-reconnect" />)
      const oldSocket = FakeWebSocket.instances.at(-1)!
      await act(async () => oldSocket.receive(JSON.stringify({ type: 'auth', canWrite: true })))
      expect(roomResult!.canWrite).toBe(true)
      expect(roomResult!.writeAuthResolved).toBe(true)

      await act(async () => oldSocket.close())
      expect(roomResult!.canWrite).toBe(false)
      expect(roomResult!.writeAuthResolved).toBe(false)

      await act(async () => vi.advanceTimersByTimeAsync(1000))
      const replacementSocket = FakeWebSocket.instances.at(-1)!
      expect(replacementSocket).not.toBe(oldSocket)
      await act(async () => replacementSocket.receive(encodeRoomStep1()))
      expect(roomResult!.synced).toBe(true)
      expect(roomResult!.canWrite).toBe(false)
      expect(roomResult!.writeAuthResolved).toBe(false)

      await act(async () =>
        replacementSocket.receive(JSON.stringify({ type: 'auth', canWrite: 'yes' })),
      )
      expect(roomResult!.writeAuthResolved).toBe(false)

      await act(async () =>
        replacementSocket.receive(JSON.stringify({ type: 'auth', canWrite: false })),
      )
      expect(roomResult!.canWrite).toBe(false)
      expect(roomResult!.writeAuthResolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails write permission closed when a same-room field replaces the socket', async () => {
    await render(<RoomProbe docId="room-field-change" />)
    const oldSocket = FakeWebSocket.instances.at(-1)!
    await act(async () => oldSocket.receive(JSON.stringify({ type: 'auth', canWrite: true })))

    await render(<RoomProbe docId="room-field-change" fieldName="alternate" />)

    expect(FakeWebSocket.instances.at(-1)).not.toBe(oldSocket)
    expect(roomResult!.canWrite).toBe(false)
    expect(roomResult!.writeAuthResolved).toBe(false)
  })

  it('reannounces local awareness after reconnect with a post-tombstone clock', async () => {
    vi.useFakeTimers()
    FakeWebSocket.autoOpen = false
    const peerDoc = new Y.Doc()
    const peerAwareness = new Awareness(peerDoc)
    try {
      await render(<RoomProbe docId="room-awareness-reconnect" />)
      const oldSocket = FakeWebSocket.instances.at(-1)!
      expect(oldSocket.readyState).toBe(FakeWebSocket.CONNECTING)

      await act(async () => roomResult!.awareness.setLocalState({ name: 'Ada' }))
      expect(oldSocket.sent).toHaveLength(0)
      await act(async () => oldSocket.open())

      expect(oldSocket.sent).toHaveLength(1)
      const initial = awarenessEntry(oldSocket.sent[0])
      handleAwarenessMessage(peerAwareness, toBytes(oldSocket.sent[0]))
      expect(peerAwareness.getStates().get(initial.clientId)).toEqual({ name: 'Ada' })

      handleAwarenessMessage(
        peerAwareness,
        new Uint8Array(encodeAwarenessTombstone(initial.clientId, initial.clock + 1)),
      )
      expect(peerAwareness.getStates().has(initial.clientId)).toBe(false)

      await act(async () => oldSocket.close())
      await act(async () => vi.advanceTimersByTimeAsync(1000))
      const replacementSocket = FakeWebSocket.instances.at(-1)!
      expect(replacementSocket).not.toBe(oldSocket)
      expect(replacementSocket.sent).toHaveLength(0)
      await act(async () => replacementSocket.open())

      expect(replacementSocket.sent).toHaveLength(1)
      const replay = awarenessEntry(replacementSocket.sent[0])
      expect(replay.clientId).toBe(initial.clientId)
      expect(replay.clock).toBeGreaterThan(initial.clock + 1)
      handleAwarenessMessage(peerAwareness, toBytes(replacementSocket.sent[0]))
      expect(peerAwareness.getStates().get(initial.clientId)).toEqual({ name: 'Ada' })
    } finally {
      peerAwareness.destroy()
      peerDoc.destroy()
      vi.useRealTimers()
    }
  })

  it('coalesces local document updates into one short-window frame', async () => {
    await render(<RoomProbe docId="room-batch" />)
    const socket = FakeWebSocket.instances.at(-1)!
    await act(async () => socket.receive(JSON.stringify({ type: 'auth', canWrite: true })))
    vi.useFakeTimers()
    try {
      await act(async () => {
        roomResult!.setText('first')
        roomResult!.setText('second')
      })
      expect(socket.sent).toHaveLength(0)

      await act(async () => vi.advanceTimersByTime(16))
      expect(socket.sent).toHaveLength(1)
      expect(roomUpdateText(socket.sent[0])).toBe('second')
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes a pending local update before closing the old room socket', async () => {
    await render(<RoomProbe docId="room-before-navigation" />)
    const oldSocket = FakeWebSocket.instances.at(-1)!
    await act(async () => oldSocket.receive(JSON.stringify({ type: 'auth', canWrite: true })))
    vi.useFakeTimers()
    try {
      await act(async () => roomResult!.setText('final edit'))
      expect(oldSocket.sent).toHaveLength(0)

      await render(<RoomProbe docId="room-after-navigation" />)

      expect(oldSocket.sent).toHaveLength(1)
      expect(roomUpdateText(oldSocket.sent[0])).toBe('final edit')
      expect(oldSocket.readyState).toBe(FakeWebSocket.CLOSED)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a malformed awareness frame and continues processing sync', async () => {
    await render(<RoomProbe docId="room-awareness" />)
    const socket = FakeWebSocket.instances.at(-1)!
    const malformed = Uint8Array.of(MSG_AWARENESS).buffer

    expect(() => socket.receive(malformed)).not.toThrow()
    await act(async () => socket.receive(encodeRoomStep1()))
    expect(socket.sent).toHaveLength(1)
  })
})
