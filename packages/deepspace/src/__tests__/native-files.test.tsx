// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DeepSpaceExpoClient,
  DeepSpaceExpoSession,
  DeepSpaceExpoSessionListener,
} from '../expo'
import { useFileSource, type FileSource, type FileSourceOptions } from '../native/files'
import { DeepSpaceNativeProvider } from '../native/provider'
import { __resetNativeSessionForTests } from '../native/session'
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function jwt(sub: string, nonce = ''): string {
  const payload = Buffer.from(
    JSON.stringify({ sub, nonce, exp: Math.floor(Date.now() / 1000) + 300 }),
  ).toString('base64url')
  return `header.${payload}.signature`
}

function fakeClient(initial: DeepSpaceExpoSession | null) {
  const listeners = new Set<DeepSpaceExpoSessionListener>()
  let session = initial
  const client = {
    origin: 'https://decisions.app.space',
    getSession: vi.fn(async () => session),
    subscribe: vi.fn((listener: DeepSpaceExpoSessionListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    getAuthToken: vi.fn(async () => session?.accessToken ?? null),
  }
  return {
    client: client as unknown as DeepSpaceExpoClient,
    emit(next: DeepSpaceExpoSession | null) {
      session = next
      for (const listener of listeners) listener(next)
    },
  }
}

let container: HTMLDivElement
let root: Root
let source: FileSource | null | undefined

function Probe({ fileKey, options }: { fileKey: string | null; options?: FileSourceOptions }) {
  source = useFileSource(fileKey, options)
  return null
}

async function render(
  client: DeepSpaceExpoClient,
  fileKey: string | null,
  options?: FileSourceOptions,
) {
  await act(async () =>
    root.render(
      <DeepSpaceNativeProvider client={client}>
        <Probe fileKey={fileKey} options={options} />
      </DeepSpaceNativeProvider>,
    ),
  )
  await act(async () => {
    await Promise.resolve()
  })
}

const KEY = 'apps/app_1/users/user-1/cards/c 1/shot.png'
const URI = 'https://decisions.app.space/api/files/apps/app_1/users/user-1/cards/c%201/shot.png'

beforeEach(() => {
  __resetNativeSessionForTests()
  source = undefined
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  __resetNativeSessionForTests()
})

describe('useFileSource', () => {
  it('carries the bearer for a private file and follows a refreshed session', async () => {
    const first = jwt('user-1', 'a')
    const fake = fakeClient({ sessionToken: 's', accessToken: first })
    await render(fake.client, KEY)
    expect(source).toEqual({
      uri: `${URI}?scope=self`,
      headers: { Authorization: `Bearer ${first}` },
    })

    const refreshed = jwt('user-1', 'b')
    await act(async () => fake.emit({ sessionToken: 's', accessToken: refreshed }))
    expect(source?.headers).toEqual({ Authorization: `Bearer ${refreshed}` })
  })

  it('is null for a private file while signed out', async () => {
    const fake = fakeClient(null)
    await render(fake.client, KEY)
    expect(source).toBeNull()
  })

  it('needs no bearer for a public file', async () => {
    const fake = fakeClient(null)
    await render(fake.client, KEY, { scope: 'app' })
    expect(source).toEqual({ uri: `${URI}?scope=app` })
  })

  it('is null without a key', async () => {
    const fake = fakeClient({ sessionToken: 's', accessToken: jwt('user-1') })
    await render(fake.client, null)
    expect(source).toBeNull()
  })
})

it('changing the private image after expiry must obtain a current bearer', async () => {
  const fake = fakeClient({ sessionToken: 's', accessToken: jwt('user-1', 'old') })
  await render(fake.client, KEY)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000)
  const renewed = jwt('user-1', 'new')
  vi.mocked(fake.client.getAuthToken).mockResolvedValue(renewed)
  // Session tokens refresh on demand, not on a timer; no session event fires just from waiting.
  try {
    await render(fake.client, KEY + '-another-image')
    expect(source?.headers?.Authorization).toBe(`Bearer ${renewed}`)
  } finally {
    clock.mockRestore()
  }
})

it('renews a private image bearer before expiry without another API call', async () => {
  vi.useFakeTimers()
  try {
    const fake = fakeClient({ sessionToken: 's', accessToken: jwt('user-1', 'old') })
    await render(fake.client, KEY)
    vi.mocked(fake.client.getAuthToken).mockImplementation(async () => jwt('user-1', 'renewed'))
    await act(async () => vi.advanceTimersByTimeAsync(270_000))
    expect(source?.headers?.Authorization).toBe(`Bearer ${jwt('user-1', 'renewed')}`)
    expect(fake.client.getAuthToken).toHaveBeenCalledTimes(2)
    await act(async () => root.unmount())
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('does not send the previous client bearer to a new app origin for the same user', async () => {
  const first = fakeClient({ sessionToken: 'first', accessToken: jwt('user-1', 'first-app') })
  await render(first.client, KEY)
  expect(source?.headers?.Authorization).toBe(`Bearer ${jwt('user-1', 'first-app')}`)
  const next = fakeClient({ sessionToken: 'next', accessToken: jwt('user-1', 'next-app') })
  Object.defineProperty(next.client, 'origin', { value: 'https://other.app.space' })
  let release!: (value: string) => void
  vi.mocked(next.client.getAuthToken).mockReturnValue(new Promise((resolve) => (release = resolve)))
  await render(next.client, KEY)
  expect(source).toBeNull()
  const token = jwt('user-1', 'next-app')
  await act(async () => release(token))
  expect(source).toEqual({
    uri: `https://other.app.space${URI.slice(first.client.origin.length)}?scope=self`,
    headers: { Authorization: `Bearer ${token}` },
  })
})
