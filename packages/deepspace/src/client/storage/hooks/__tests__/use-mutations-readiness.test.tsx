// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RecordContext, type RecordContextValue } from '../../context'
import { RecordRoomNotReadyError } from '../../errors'
import { RecordStore } from '../../store'
import { useMutations } from '../useMutations'
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const sendMessage = vi.fn()
const sendConfirmed = vi.fn(async () => ({}))
let result: ReturnType<typeof useMutations<{ title: string }>> | null = null
let container: HTMLDivElement
let root: Root

function Probe() {
  result = useMutations<{ title: string }>('tasks')
  return null
}

function contextValue(ready: boolean): RecordContextValue {
  return {
    store: new RecordStore(),
    roomId: 'app:test',
    registeredCollections: new Set(['tasks']),
    userProfile: null,
    userProfileLoading: false,
    refetchUserProfile: async () => {},
    roomRole: null,
    allUsers: [],
    usersLoaded: false,
    status: ready ? 'connected' : 'connecting',
    ready,
    setUserRole: vi.fn(),
    requestUserList: vi.fn(),
    registerSubscription: vi.fn(),
    unregisterSubscription: vi.fn(),
    sendMessage,
    sendBinary: vi.fn(),
    onBinaryMessage: vi.fn(() => () => {}),
    registerYjsJoinHandler: vi.fn(() => () => {}),
    sendConfirmed,
  }
}

async function render(ui: ReactElement): Promise<void> {
  await act(async () => root.render(ui))
}

beforeEach(() => {
  result = null
  sendMessage.mockClear()
  sendConfirmed.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('useMutations readiness', () => {
  it('exposes readiness and rejects writes with a stable error until ready', async () => {
    await render(
      <RecordContext.Provider value={contextValue(false)}>
        <Probe />
      </RecordContext.Provider>,
    )

    expect(result!.ready).toBe(false)
    await expect(result!.create({ title: 'too soon' })).rejects.toMatchObject({
      name: 'RecordRoomNotReadyError',
      code: 'not_ready',
    } satisfies Partial<RecordRoomNotReadyError>)
    expect(sendMessage).not.toHaveBeenCalled()

    await render(
      <RecordContext.Provider value={contextValue(true)}>
        <Probe />
      </RecordContext.Provider>,
    )

    expect(result!.ready).toBe(true)
    await result!.put('task-1', { title: 'ready' })
    expect(sendMessage).toHaveBeenCalledOnce()
  })
})
