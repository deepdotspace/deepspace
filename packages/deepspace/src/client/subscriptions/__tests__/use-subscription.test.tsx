// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ isLoaded: true, userId: null as string | null }))
const authedJson = vi.hoisted(() => vi.fn())

vi.mock('../../auth/hooks', () => ({
  useAuth: () => ({
    isLoaded: auth.isLoaded,
    isSignedIn: !!auth.userId,
    userId: auth.userId,
    sessionId: null,
  }),
}))
vi.mock('../../authed-json', () => ({ authedJson }))

import { useSubscription } from '../useSubscription'
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let sub: ReturnType<typeof useSubscription> | null = null

function Probe(): ReactElement | null {
  sub = useSubscription()
  return null
}

async function render() {
  await act(async () => {
    root.render(<Probe />)
    await Promise.resolve()
  })
}

const PRO = {
  tier: 'pro',
  status: 'active',
  interval: 'month',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  trialEndsAt: null,
  plans: [
    { slug: 'free', rank: 0, name: 'Free', prices: [] },
    { slug: 'pro', rank: 1, name: 'Pro', prices: [] },
  ],
}

beforeEach(() => {
  sub = null
  auth.isLoaded = true
  auth.userId = null
  authedJson.mockReset()
  container = document.createElement('div')
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
})

describe('useSubscription and auth', () => {
  it('does not ask the platform for a signed-out visitor', async () => {
    await render()
    expect(authedJson).not.toHaveBeenCalled()
    expect(sub!.isLoading).toBe(false)
    expect(sub!.error).toBeNull()
    expect(sub!.tier).toBe('free')
  })

  it('waits for auth to resolve before reading', async () => {
    auth.isLoaded = false
    auth.userId = 'user-1'
    await render()
    expect(authedJson).not.toHaveBeenCalled()
  })

  it('reads on sign-in and resets on sign-out', async () => {
    authedJson.mockResolvedValue(PRO)
    await render()
    expect(authedJson).not.toHaveBeenCalled()

    auth.userId = 'user-1'
    await render()
    expect(authedJson).toHaveBeenCalledTimes(1)
    expect(sub!.isAtLeast('pro')).toBe(true)

    auth.userId = null
    await render()
    expect(sub!.tier).toBe('free')
    expect(sub!.isAtLeast('pro')).toBe(false)
  })

  it('drops a response that lands after sign-out', async () => {
    let resolve!: (v: unknown) => void
    authedJson.mockReturnValue(new Promise((r) => (resolve = r)))
    auth.userId = 'user-1'
    await render()
    expect(sub!.isLoading).toBe(true)

    auth.userId = null
    await render()
    await act(async () => resolve(PRO))
    expect(sub!.tier).toBe('free')
    expect(sub!.isAtLeast('pro')).toBe(false)
    expect(sub!.isLoading).toBe(false)
  })

  it("never shows one account's tier to the next, even when responses arrive out of order", async () => {
    const pending: Record<string, (v: unknown) => void> = {}
    authedJson.mockImplementation(() => new Promise((r) => (pending[auth.userId!] = r)))
    auth.userId = 'user-a'
    await render()
    auth.userId = 'user-b'
    await render()
    expect(sub!.tier).toBe('free')

    await act(async () => pending['user-b']({ ...PRO, tier: 'free', status: 'none' }))
    await act(async () => pending['user-a'](PRO))
    expect(sub!.tier).toBe('free')
    expect(sub!.isAtLeast('pro')).toBe(false)
  })

  it('refresh() makes no request while signed out', async () => {
    await render()
    await act(async () => sub!.refresh())
    expect(authedJson).not.toHaveBeenCalled()
    expect(sub!.error).toBeNull()
  })

  it('refuses subscribe and openPortal while signed out without a request', async () => {
    await render()
    await expect(sub!.subscribe('pro')).rejects.toMatchObject({ code: 'unauthorized', status: 401 })
    await expect(sub!.openPortal()).rejects.toMatchObject({ code: 'unauthorized' })
    expect(authedJson).not.toHaveBeenCalled()
  })

  it('does not report signed-out state or refuse checkout before auth loads', async () => {
    auth.isLoaded = false
    auth.userId = null
    await render()
    await act(async () => sub!.refresh())
    expect(sub!.isLoading).toBe(true)
    authedJson.mockResolvedValue({ url: null, immediate: false })
    await expect(sub!.openPortal()).resolves.toBeDefined()
  })

  it("clears the previous user's error when the account changes", async () => {
    authedJson.mockRejectedValueOnce(new Error('A failed'))
    auth.userId = 'user-a'
    await render()
    expect(sub!.error).toBe('A failed')
    authedJson.mockReturnValue(new Promise(() => {}))
    auth.userId = 'user-b'
    await render()
    expect(sub!.error).toBeNull()
    expect(sub!.isLoading).toBe(true)
  })
})
