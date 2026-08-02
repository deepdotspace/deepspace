// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useR2Files, type UseR2FilesReturn } from '../useR2Files'

vi.mock('../../auth', () => ({
  getAuthToken: async () => 'test-token',
}))
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let files: UseR2FilesReturn | null = null

function Probe(): ReactElement | null {
  files = useR2Files()
  return null
}

beforeEach(async () => {
  files = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<Probe />)
    await Promise.resolve()
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('useR2Files URL paths', () => {
  it('encodes each key segment for plain URLs and authenticated requests', async () => {
    const key = 'apps/app-a/users/user-1/report ?#% ü.txt'
    const expected = '/api/files/apps/app-a/users/user-1/report%20%3F%23%25%20%C3%BC.txt?scope=self'
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input, init })
        return init?.method === 'DELETE'
          ? Response.json({ success: true })
          : new Response('contents')
      }),
    )

    expect(files!.getUrl(key)).toBe(expected)
    await expect(files!.deleteFile(key)).resolves.toEqual({ success: true })
    await expect(files!.readFile(key).then((response) => response.text())).resolves.toBe('contents')

    expect(requests.map(({ input }) => String(input))).toEqual([expected, expected])
    expect(requests[0].init).toMatchObject({
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-token' },
    })
  })
})
