// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DeepSpaceExpoClient,
  DeepSpaceExpoSession,
  DeepSpaceExpoSessionListener,
} from '../expo'
import { DeepSpaceNativeProvider, useDeepSpace } from '../native/provider'
import {
  __resetNativeSessionForTests,
  currentNativeClient,
  getNativeAuthToken,
  requireNativeClient,
  type NativeAuthState,
} from '../native/session'
import { callAction } from '../native/actions'
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function jwt(sub: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 300 }),
  ).toString('base64url')
  return `header.${payload}.signature`
}

/** The subset of DeepSpaceExpoClient the native bindings use, with test controls. */
function fakeClient(initial: DeepSpaceExpoSession | null) {
  const listeners = new Set<DeepSpaceExpoSessionListener>()
  let session = initial
  let resolveLoad: () => void = () => {}
  const loaded = new Promise<void>((resolve) => {
    resolveLoad = resolve
  })
  const emit = (next: DeepSpaceExpoSession | null) => {
    session = next
    for (const listener of listeners) listener(next)
  }
  const client = {
    origin: 'https://tasks.app.space',
    getSession: vi.fn(async () => {
      await loaded
      return session
    }),
    subscribe: vi.fn((listener: DeepSpaceExpoSessionListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    getAuthToken: vi.fn(async () => session?.accessToken ?? null),
    signIn: vi.fn(async () => {
      emit({ sessionToken: 'new-session', accessToken: jwt('user-2') })
      return { userId: 'user-2', claims: {} }
    }),
    signOut: vi.fn(async () => emit(null)),
    request: vi.fn(async () => ({ success: true, data: { id: 'task-1' } })),
  }
  return {
    client: client as unknown as DeepSpaceExpoClient,
    raw: client,
    finishLoading: resolveLoad,
    emit,
  }
}

let container: HTMLDivElement
let root: Root
let latest:
  | (NativeAuthState & { signIn: () => Promise<unknown>; signOut: () => Promise<void> })
  | null

function Probe() {
  latest = useDeepSpace()
  return null
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  __resetNativeSessionForTests()
  latest = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  __resetNativeSessionForTests()
})

describe('deepspace/native session', () => {
  it('reports loading, then the stored session, then live sign-in and sign-out', async () => {
    const fake = fakeClient({ sessionToken: 'stored', accessToken: jwt('user-1') })
    await act(async () =>
      root.render(
        <DeepSpaceNativeProvider client={fake.client}>
          <Probe />
        </DeepSpaceNativeProvider>,
      ),
    )
    expect(latest).toMatchObject({ isLoaded: false, isSignedIn: false, userId: null })

    fake.finishLoading()
    await flush()
    expect(latest).toMatchObject({
      isLoaded: true,
      isSignedIn: true,
      userId: 'user-1',
      sessionId: null,
    })

    await act(async () => {
      await latest!.signOut()
    })
    expect(latest).toMatchObject({ isLoaded: true, isSignedIn: false, userId: null })

    await act(async () => {
      await latest!.signIn()
    })
    expect(latest).toMatchObject({ isLoaded: true, isSignedIn: true, userId: 'user-2' })
  })

  it('signs out when the client reports an expired session', async () => {
    const fake = fakeClient({ sessionToken: 'stored', accessToken: jwt('user-1') })
    fake.finishLoading()
    await act(async () =>
      root.render(
        <DeepSpaceNativeProvider client={fake.client}>
          <Probe />
        </DeepSpaceNativeProvider>,
      ),
    )
    await flush()
    expect(latest?.isSignedIn).toBe(true)

    await act(async () => fake.emit(null))
    expect(latest).toMatchObject({ isLoaded: true, isSignedIn: false })
  })

  it('binds the client for plain functions and ignores a replaced client', async () => {
    expect(currentNativeClient()).toBeNull()
    expect(() => requireNativeClient()).toThrow(/DeepSpaceNativeProvider/)
    await expect(getNativeAuthToken()).resolves.toBeNull()

    const first = fakeClient(null)
    const second = fakeClient({ sessionToken: 's', accessToken: jwt('user-3') })
    second.finishLoading()
    await act(async () =>
      root.render(
        <DeepSpaceNativeProvider client={first.client}>
          <Probe />
        </DeepSpaceNativeProvider>,
      ),
    )
    await act(async () =>
      root.render(
        <DeepSpaceNativeProvider client={second.client}>
          <Probe />
        </DeepSpaceNativeProvider>,
      ),
    )
    await flush()
    expect(requireNativeClient()).toBe(second.client)
    expect(latest).toMatchObject({ isSignedIn: true, userId: 'user-3' })

    // The first client's late load and events must not overwrite the second.
    first.finishLoading()
    await act(async () => first.emit(null))
    await flush()
    expect(latest).toMatchObject({ isSignedIn: true, userId: 'user-3' })
    await expect(getNativeAuthToken()).resolves.toBe(jwt('user-3'))
  })

  it('posts server actions through the bound client', async () => {
    const fake = fakeClient(null)
    await act(async () =>
      root.render(
        <DeepSpaceNativeProvider client={fake.client}>
          <Probe />
        </DeepSpaceNativeProvider>,
      ),
    )
    await expect(callAction('complete task', { id: 'task-1' })).resolves.toEqual({
      success: true,
      data: { id: 'task-1' },
    })
    expect(fake.raw.request).toHaveBeenCalledWith('/api/actions/complete%20task', {
      method: 'POST',
      body: JSON.stringify({ id: 'task-1' }),
    })
  })
})
