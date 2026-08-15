// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useR2Files,
  type R2FileInfo,
  type R2UploadResult,
  type UseR2FilesReturn,
} from '../useR2Files'
import {
  MAX_APP_FILE_BYTES,
  MAX_BASE64_UPLOAD_BYTES,
  MAX_UPLOAD_REQUEST_BYTES,
  UPLOAD_PART_BYTES,
} from '../../../shared/app-files'

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

  it('sends a caller-named key so the chosen prefix can list the file back', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input))
        return Response.json({ success: true, key: 'apps/a/users/u/showcase/report.csv' })
      }),
    )
    await act(async () => {
      await files!.upload(new Blob(['a,b\n']), 'report.csv', { key: 'showcase/report.csv' })
      await files!.uploadBase64('QQ==', 'report.csv', 'text/csv', { key: 'showcase/report.csv' })
      await files!.upload(new Blob(['a,b\n']), 'report.csv')
    })
    expect(urls).toHaveLength(3)
    expect(urls[0]).toContain('/api/files/upload')
    expect(urls[0]).toContain('key=showcase%2Freport.csv')
    expect(urls[1]).toContain('key=showcase%2Freport.csv')
    // Without the option no key param is sent — the server generates the key.
    expect(urls[2]).not.toContain('key=')
  })
})

describe('useR2Files list', () => {
  it('passes prefix, limit, and cursor through to the query', async () => {
    const urls: string[] = []
    const listed: R2FileInfo = { key: 'showcase/report.csv', size: 5, uploaded: 'now', url: '/u' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input))
        return Response.json({ files: [listed], truncated: false })
      }),
    )
    await expect(files!.list('showcase', { limit: 5, cursor: 'cursor-1' })).resolves.toEqual([
      listed,
    ])
    const params = new URL(urls[0], 'https://x').searchParams
    expect(urls[0]).toContain('/api/files?')
    expect(params.get('scope')).toBe('self')
    expect(params.get('prefix')).toBe('showcase')
    expect(params.get('limit')).toBe('5')
    expect(params.get('cursor')).toBe('cursor-1')
  })

  it('listPage surfaces the continuation state list flattens away', async () => {
    const urls: string[] = []
    // The server names the key both ways; the relative one is what a client
    // can hand back to list('showcase') or upload(..., { key }).
    const listed: R2FileInfo = {
      key: 'apps/a/users/u/showcase/report.csv',
      relativeKey: 'showcase/report.csv',
      size: 5,
      uploaded: 'now',
      url: '/u',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input))
        return new URL(String(input), 'https://x').searchParams.get('cursor')
          ? Response.json({ files: [], truncated: false })
          : Response.json({ files: [listed], truncated: true, cursor: 'cursor-1' })
      }),
    )
    const page = await files!.listPage('showcase', { limit: 1 })
    expect(page).toEqual({ files: [listed], cursor: 'cursor-1', truncated: true })
    const rest = await files!.listPage('showcase', { limit: 1, cursor: page.cursor })
    expect(rest).toEqual({ files: [], cursor: undefined, truncated: false })
    expect(new URL(urls[1], 'https://x').searchParams.get('cursor')).toBe('cursor-1')
  })

  it('reads an older server without cursor or truncated as a complete page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ files: [] })),
    )
    await expect(files!.listPage()).resolves.toEqual({
      files: [],
      cursor: undefined,
      truncated: false,
    })
  })

  it('rejects on an auth failure instead of reading it as an empty account', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'Valid authentication required' }, { status: 401 })),
    )
    await expect(files!.list()).rejects.toThrow('Valid authentication required')
  })

  it('lets a transport failure propagate rather than resolving []', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(files!.list()).rejects.toThrow('Failed to fetch')
  })
})

describe('useR2Files upload limits', () => {
  /** Fails the test if the hook opens a socket at all. */
  function forbidFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => Response.json({ success: true }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('refuses an over-ceiling File before sending it', async () => {
    const fetchMock = forbidFetch()
    // Declared size only: allocating a gibibyte to prove a size check runs
    // before any allocation would be its own bug.
    const big = { size: MAX_APP_FILE_BYTES + 1, type: 'video/mp4' } as Blob
    let result: R2UploadResult | null = null
    await act(async () => {
      result = await files!.upload(big, 'big.bin')
    })
    expect(result).toMatchObject({ success: false })
    expect(result!.error).toContain('the limit is')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a base64 upload whose ENCODED body would not fit one request', async () => {
    const fetchMock = forbidFetch()
    // The budget is the encoded string, because that is what the request body
    // is. A payload measured only by its decoded size sits under the request
    // bound while producing a body a third larger — so this decodes to just
    // over 18.75 MiB, which is comfortably under 25 MiB decoded and was
    // previously waved through to a guaranteed server 413.
    const base64 = 'A'.repeat(Math.ceil(((MAX_BASE64_UPLOAD_BYTES + 1) * 4) / 3))
    expect(Math.floor((base64.length * 3) / 4)).toBeLessThan(MAX_UPLOAD_REQUEST_BYTES)
    let result: R2UploadResult | null = null
    await act(async () => {
      result = await files!.uploadBase64(base64, 'big.bin', 'image/png')
    })
    expect(result).toMatchObject({ success: false })
    expect(result!.error).toContain('the limit is')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends a file at exactly the part size in one request', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input))
        return Response.json({ success: true, key: 'k' })
      }),
    )
    await act(async () => {
      await files!.upload(new Blob([new Uint8Array(UPLOAD_PART_BYTES)]), 'exact.bin')
    })
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('/api/files/upload')
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

/**
 * Chunked uploads.
 *
 * The file is a stand-in with a real `size` and a `slice` that records the
 * range asked for: what matters is which bytes the hook asks for and in what
 * order, and allocating hundreds of megabytes to observe that would defeat the
 * point of a transport that does not allocate them either.
 */
describe('useR2Files chunked upload', () => {
  interface FakeFile {
    blob: Blob
    slices: Array<{ start: number; end: number }>
  }

  function fakeFile(size: number, type = 'video/mp4'): FakeFile {
    const slices: Array<{ start: number; end: number }> = []
    const blob = {
      size,
      type,
      slice(start: number, end: number) {
        slices.push({ start, end })
        return { size: end - start, __range: `${start}-${end}` } as unknown as Blob
      },
    } as unknown as Blob
    return { blob, slices }
  }

  interface Call {
    url: string
    method: string
    body: unknown
  }

  /** A server that plays the whole protocol, with hooks to make any step fail. */
  function stubServer(
    options: {
      partSize?: number
      failPart?: number
      failComplete?: boolean
      failInit?: boolean
      flakyInit?: boolean
      /** Fail this part with this status, but only on its FIRST attempt. */
      flakyPart?: { partNumber: number; status: number }
    } = {},
  ): Call[] {
    const partSize = options.partSize ?? UPLOAD_PART_BYTES
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body })
        if (url.includes('/multipart/part')) {
          const partNumber = Number(new URL(url, 'https://x').searchParams.get('partNumber'))
          if (options.failPart === partNumber) {
            return Response.json({ error: 'part exploded' }, { status: 503 })
          }
          const flaky = options.flakyPart
          if (flaky?.partNumber === partNumber) {
            const already = calls.filter(
              (c) =>
                c.url.includes('/multipart/part') && c.url.includes(`partNumber=${partNumber}`),
            ).length
            // `calls` already includes this attempt, so 1 means first try.
            if (already <= 1) return Response.json({ error: 'flaky' }, { status: flaky.status })
          }
          return Response.json({ partNumber, etag: `etag-${partNumber}` })
        }
        if (url.includes('/multipart/complete')) {
          return options.failComplete
            ? Response.json({ error: 'assembly failed' }, { status: 400 })
            : Response.json({ success: true, key: 'apps/a/big.mp4', name: 'big.mp4' })
        }
        if (url.includes('/multipart')) {
          if (init?.method === 'DELETE') return Response.json({ success: true, aborted: true })
          const initAttempts = calls.filter(
            (call) =>
              call.method === 'POST' &&
              new URL(call.url, 'https://x').pathname.endsWith('/multipart'),
          ).length
          if (options.flakyInit && initAttempts === 1) {
            return Response.json({ error: 'temporary' }, { status: 503 })
          }
          return options.failInit
            ? Response.json({ error: 'That file is too big' }, { status: 413 })
            : Response.json({
                uploadId: 'up-1',
                uploadKey: 'gen/big.mp4',
                reservationId: 'reservation-browser-1',
                partSize,
              })
        }
        return Response.json({ success: true, key: 'single' })
      }),
    )
    return calls
  }

  it('runs init → parts → complete for a file above the single-request bound', async () => {
    const calls = stubServer()
    const file = fakeFile(UPLOAD_PART_BYTES * 2 + 500)
    let result: R2UploadResult | null = null
    await act(async () => {
      result = await files!.upload(file.blob, 'big.mp4')
    })

    expect(result).toMatchObject({ success: true, key: 'apps/a/big.mp4' })
    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual([
      'POST /api/files/multipart',
      'PUT /api/files/multipart/part',
      'PUT /api/files/multipart/part',
      'PUT /api/files/multipart/part',
      'POST /api/files/multipart/complete',
    ])

    // Init declares the total up front, so the server can refuse before bytes.
    const initBody = JSON.parse(calls[0].body as string) as Record<string, unknown>
    expect(initBody).toMatchObject({
      name: 'big.mp4',
      mimeType: 'video/mp4',
      size: UPLOAD_PART_BYTES * 2 + 500,
    })
    expect(initBody.requestId).toEqual(expect.any(String))

    // Every part carries the session the server named, never a client guess.
    for (const call of calls.slice(1, 4)) {
      const params = new URL(call.url, 'https://x').searchParams
      expect(params.get('uploadKey')).toBe('gen/big.mp4')
      expect(params.get('uploadId')).toBe('up-1')
      expect(params.get('reservationId')).toBe('reservation-browser-1')
      expect(params.get('scope')).toBe('self')
    }

    // The ranges tile the file exactly, uniform except the last — R2's rule.
    expect(file.slices).toEqual([
      { start: 0, end: UPLOAD_PART_BYTES },
      { start: UPLOAD_PART_BYTES, end: UPLOAD_PART_BYTES * 2 },
      { start: UPLOAD_PART_BYTES * 2, end: UPLOAD_PART_BYTES * 2 + 500 },
    ])

    expect(JSON.parse(calls[4].body as string)).toEqual({
      parts: [
        { partNumber: 1, etag: 'etag-1' },
        { partNumber: 2, etag: 'etag-2' },
        { partNumber: 3, etag: 'etag-3' },
      ],
    })
  })

  it('carries the caller-named key on init, and only on init', async () => {
    const calls = stubServer()
    let result: R2UploadResult | null = null
    await act(async () => {
      result = await files!.upload(fakeFile(UPLOAD_PART_BYTES + 1).blob, 'report.csv', {
        key: 'showcase/report.csv',
      })
    })
    expect(result).toMatchObject({ success: true })
    const [init, ...rest] = calls
    expect(init.url).toContain('/api/files/multipart?')
    expect(init.url).toContain('key=showcase%2Freport.csv')
    // Parts and complete address the session's uploadKey, not the caller's name.
    expect(rest.length).toBeGreaterThan(0)
    for (const call of rest) {
      expect(new URL(call.url, 'https://x').searchParams.get('key')).toBeNull()
    }
  })

  it('refuses a server response that disagrees with the fixed layout', async () => {
    const calls = stubServer({ partSize: 6 * 1024 * 1024 })
    const file = fakeFile(UPLOAD_PART_BYTES + 1)
    let result: R2UploadResult | null = null
    await act(async () => {
      result = await files!.upload(file.blob, 'big.mp4')
    })
    expect(result).toMatchObject({ success: false })
    expect(file.slices).toEqual([])
    expect(calls.filter((c) => c.url.includes('/multipart/part'))).toHaveLength(0)
  })

  it('aborts the session when a part fails, and reports the failure', async () => {
    const calls = stubServer({ failPart: 2 })
    let result: R2UploadResult | null = null
    await act(async () => {
      result = await files!.upload(fakeFile(UPLOAD_PART_BYTES * 3).blob, 'big.mp4')
    })
    expect(result).toMatchObject({ success: false })
    expect(result!.error).toBe('part exploded')
    // Three part requests: part 1, then part 2 twice — retried once because
    // 503 is retryable, and then given up on. Retrying is not a loop.
    expect(calls.filter((c) => c.url.includes('/multipart/part'))).toHaveLength(3)
    // Part 3 is never attempted, and the parts that landed are released.
    expect(calls.filter((c) => c.url.includes('partNumber=3'))).toHaveLength(0)
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' })
  })

  it('aborts when assembly fails — parts left behind would hold the quota', async () => {
    const calls = stubServer({ failComplete: true })
    let result: R2UploadResult | null = null
    await act(async () => {
      result = await files!.upload(fakeFile(UPLOAD_PART_BYTES * 2).blob, 'big.mp4')
    })
    expect(result).toMatchObject({ success: false, error: 'assembly failed' })
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' })
  })

  it('does not abort a completed upload', async () => {
    const calls = stubServer()
    await act(async () => {
      await files!.upload(fakeFile(UPLOAD_PART_BYTES * 2).blob, 'big.mp4')
    })
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('stops at init when the server refuses the declared total', async () => {
    const calls = stubServer({ failInit: true })
    let result: R2UploadResult | null = null
    await act(async () => {
      result = await files!.upload(fakeFile(UPLOAD_PART_BYTES * 2).blob, 'big.mp4')
    })
    expect(result).toMatchObject({ success: false, error: 'That file is too big' })
    expect(calls).toHaveLength(1)
  })

  it('retries a transient init with the same request id', async () => {
    const calls = stubServer({ flakyInit: true })
    await act(async () => {
      await files!.upload(fakeFile(UPLOAD_PART_BYTES + 1).blob, 'big.mp4')
    })
    const inits = calls.filter(
      (call) =>
        call.method === 'POST' && new URL(call.url, 'https://x').pathname.endsWith('/multipart'),
    )
    expect(inits).toHaveLength(2)
    const requestIds = inits.map(
      (call) => (JSON.parse(call.body as string) as { requestId: string }).requestId,
    )
    expect(new Set(requestIds).size).toBe(1)
  })

  it('reports progress after each part', async () => {
    stubServer()
    const seen: Array<[number, number]> = []
    const total = UPLOAD_PART_BYTES * 2 + 7
    await act(async () => {
      await files!.upload(fakeFile(total).blob, 'big.mp4', {
        onProgress: (sent, all) => seen.push([sent, all]),
      })
    })
    expect(seen).toEqual([
      [UPLOAD_PART_BYTES, total],
      [UPLOAD_PART_BYTES * 2, total],
      [total, total],
    ])
  })

  it('retries a part ONCE on a retryable failure, then carries on', async () => {
    const calls = stubServer({ flakyPart: { partNumber: 2, status: 503 } })
    const file = fakeFile(UPLOAD_PART_BYTES * 3)
    let result: R2UploadResult | null = null
    await act(async () => {
      result = await files!.upload(file.blob, 'big.mp4')
    })
    expect(result).toMatchObject({ success: true })
    // Four part requests for three parts: part 2 was attempted twice. Without
    // the retry a transient on part 40 of 52 would throw away everything.
    const partCalls = calls.filter((c) => c.url.includes('/multipart/part'))
    expect(partCalls).toHaveLength(4)
    // The retry re-sliced rather than re-sending a consumed body.
    expect(file.slices.filter((s) => s.start === UPLOAD_PART_BYTES)).toHaveLength(2)
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('does not retry a refusal the server will repeat', async () => {
    // 4xx is the client's mistake; retrying spends another part upload to
    // reach the same answer.
    const calls = stubServer({ flakyPart: { partNumber: 1, status: 415 } })
    let result: R2UploadResult | null = null
    await act(async () => {
      result = await files!.upload(fakeFile(UPLOAD_PART_BYTES * 2).blob, 'big.mp4')
    })
    expect(result).toMatchObject({ success: false })
    expect(calls.filter((c) => c.url.includes('/multipart/part'))).toHaveLength(1)
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' })
  })

  it('refuses every non-canonical part size', async () => {
    for (const partSize of [0, -1, 5 * 1024 * 1024]) {
      const calls = stubServer({ partSize })
      let result: R2UploadResult | null = null
      await act(async () => {
        result = await files!.upload(fakeFile(UPLOAD_PART_BYTES * 2).blob, 'big.mp4')
      })
      expect(result, String(partSize)).toMatchObject({ success: false })
      expect(result!.error).toContain('unusable part size')
      expect(calls.filter((c) => c.url.includes('/multipart/part'))).toHaveLength(0)
    }
  })
})
