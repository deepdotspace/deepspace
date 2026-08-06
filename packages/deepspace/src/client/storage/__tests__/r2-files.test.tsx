// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useR2Files, type R2UploadResult, type UseR2FilesReturn } from '../useR2Files'
import { MAX_APP_FILE_BYTES } from '../../../shared/app-files'

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

describe('useR2Files upload limits', () => {
  /** Fails the test if the hook opens a socket at all. */
  function forbidFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => Response.json({ success: true }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('refuses an over-limit File before sending it', async () => {
    const fetchMock = forbidFetch()
    const big = new Blob([new Uint8Array(MAX_APP_FILE_BYTES + 1)])
    let result: R2UploadResult | null = null
    await act(async () => {
      result = await files!.upload(big, 'big.bin')
    })
    expect(result).toMatchObject({ success: false })
    expect(result!.error).toContain('the limit is')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an over-limit base64 upload, measured on DECODED bytes', async () => {
    const fetchMock = forbidFetch()
    // 4 base64 chars per 3 bytes: this string is under the cap in characters
    // only if you forget to decode it.
    const base64 = 'A'.repeat(Math.ceil(((MAX_APP_FILE_BYTES + 1) * 4) / 3))
    let result: R2UploadResult | null = null
    await act(async () => {
      result = await files!.uploadBase64(base64, 'big.bin', 'image/png')
    })
    expect(result).toMatchObject({ success: false })
    expect(result!.error).toContain('the limit is')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still sends a file at exactly the limit', async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true, key: 'k' }))
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => {
      await files!.upload(new Blob([new Uint8Array(MAX_APP_FILE_BYTES)]), 'exact.bin')
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports an edge HTML 413 as a size limit, not a JSON parse error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<!DOCTYPE html><html><title>413</title></html>', {
            status: 413,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    )
    let result: R2UploadResult | null = null
    await act(async () => {
      result = await files!.upload(new Blob(['small']), 'small.txt')
    })
    expect(result).toMatchObject({ success: false })
    expect(result!.error).not.toMatch(/JSON|Unexpected token|</)
    expect(result!.error).toContain('too large')
  })
})
