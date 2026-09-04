/**
 * The shared files handler's request-length chokepoint, called directly.
 *
 * These cases live here rather than in the platform-worker's workerd suite for
 * a mechanical reason: they need a request body with NO `Content-Length`, which
 * means a live stream, and a worker that answers such a request WITHOUT reading
 * its body makes the workerd test client emit an unowned "Network connection
 * lost" rejection — noise about the harness, not about the code. Calling
 * `createScopedR2Handler` directly exercises exactly the same chokepoint (it is
 * the only place the check exists, and both mounts dispatch through it) with
 * nothing in between.
 *
 * Everything that needs real R2 semantics stays in
 * `platform/platform-worker/src/__tests__/multipart-files.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest'
import { createScopedR2Handler } from '../scoped-r2-files'

const PREFIX = 'apps/app-a/'

/** A bucket that fails loudly: nothing here should reach storage. */
const bucket = new Proxy(
  {},
  {
    get(_target, property) {
      return () => {
        throw new Error(`R2 must not be touched — the handler called ${String(property)}()`)
      }
    },
  },
) as unknown as R2Bucket

const handler = createScopedR2Handler({ resolvePrefix: () => ({ prefix: PREFIX }) })

/** A body with no Content-Length: a stream forces chunked encoding. */
function lengthless(totalBytes: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(totalBytes).fill(65))
      controller.close()
    },
  })
}

/**
 * `declaredLength` is set explicitly rather than inferred, because a `Request`
 * constructed in memory carries no `Content-Length` at all — the runtime adds
 * it when the request is put on a wire. That is precisely the distinction under
 * test, so the header is the input, not a side effect of the body.
 */
function call(
  path: string,
  method: string,
  body: BodyInit | null,
  declaredLength?: number,
): Promise<Response> {
  const url = new URL(`https://app.example${path}`)
  const request = new Request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(declaredLength === undefined ? {} : { 'content-length': String(declaredLength) }),
    },
    body,
    // Required by undici/workerd for a stream body.
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit)
  return handler(request, url, bucket, { userId: 'user-1' })
}

describe('a request that declares no length', () => {
  // `Number(null)` is 0, so reading the header without testing for its ABSENCE
  // treated a chunked body as an empty one — and it then cleared every size
  // bound before anything had been read. The control bodies sailed past the
  // 64 KiB cap into an unbounded `request.json()`; a part reached
  // `FixedLengthStream(0)` and was blamed for "declaring 0 bytes".
  const session = 'uploadKey=video.mp4&uploadId=up-1'

  it.each([
    ['single upload', '/api/files/upload?scope=app', 'POST'],
    ['init', '/api/files/multipart?scope=app&key=video.mp4', 'POST'],
    ['part', `/api/files/multipart/part?scope=app&${session}&partNumber=1`, 'PUT'],
    ['complete', `/api/files/multipart/complete?scope=app&${session}`, 'POST'],
  ])('is refused with 411 on %s, before the body is read', async (_label, path, method) => {
    // 200 KiB — comfortably past the 64 KiB control-body cap it used to slip
    // under, and past nothing at all once the header is missing.
    const res = await call(path, method, lengthless(200 * 1024))
    expect(res.status).toBe(411)
    expect(await res.json()).toMatchObject({ code: 'length_required' })
  })

  it('says what is wrong and why, rather than blaming the body', async () => {
    const res = await call(
      `/api/files/multipart/part?scope=app&${session}&partNumber=1`,
      'PUT',
      lengthless(1024),
    )
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('Content-Length')
    // The old failure accused the client of sending a short body.
    expect(body.error).not.toMatch(/did not carry|declared 0 bytes/)
  })

  it('lets the same request through once it declares a length', async () => {
    // A declared length gets past the 411 and on to the real validation — here
    // the part-number budget — which proves the guard is about the header, not
    // about rejecting everything.
    const res = await call(
      `/api/files/multipart/part?scope=app&${session}&partNumber=0`,
      'PUT',
      new Uint8Array(1024),
      1024,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'bad_request' })
  })

  it('refuses a length that is not a byte count', async () => {
    for (const bad of ['-1', 'lots', '1.5']) {
      const url = new URL(`https://app.example/api/files/multipart?scope=app&key=k.mp4`)
      const request = new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': bad },
        body: JSON.stringify({ name: 'k.mp4', mimeType: 'video/mp4', size: 10 }),
      })
      const res = await handler(request, url, bucket, { userId: 'user-1' })
      expect(res.status, bad).toBe(411)
    }
  })

  it('requires a retry-stable request id before creating a multipart session', async () => {
    const body = JSON.stringify({ name: 'k.mp4', mimeType: 'video/mp4', size: 10 })
    const res = await call(
      '/api/files/multipart?scope=app&key=k.mp4',
      'POST',
      body,
      new TextEncoder().encode(body).byteLength,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'bad_request' })
  })
})

describe('file listing metadata', () => {
  it('requests custom metadata on every page and returns the original name', async () => {
    type MetadataListOptions = R2ListOptions & { include?: string[] }
    const calls: MetadataListOptions[] = []
    const privateKey = `${PREFIX}private/hidden.txt`
    const publicKey = `${PREFIX}visible/generated-key.txt`
    const listedBucket = {
      async list(options: MetadataListOptions = {}) {
        calls.push(options)
        const includeMetadata = options.include?.includes('customMetadata')
        const object = (key: string, originalName: string) => ({
          key,
          size: 12,
          uploaded: new Date('2026-08-14T00:00:00Z'),
          ...(includeMetadata ? { customMetadata: { originalName } } : {}),
        })
        return calls.length === 1
          ? { objects: [object(privateKey, 'hidden.txt')], truncated: true }
          : { objects: [object(publicKey, 'report.txt')], truncated: false }
      },
    } as unknown as R2Bucket
    const listHandler = createScopedR2Handler({
      resolvePrefix: () => ({ prefix: PREFIX, excludedPrefixes: [`${PREFIX}private/`] }),
    })
    const url = new URL('https://app.example/api/files?scope=app')
    const response = await listHandler(new Request(url), url, listedBucket, { userId: 'user-1' })
    const body = (await response.json()) as {
      files: Array<{ key: string; originalName?: string }>
    }

    expect(calls).toHaveLength(2)
    expect(calls.every((options) => options.include?.includes('customMetadata'))).toBe(true)
    expect(body.files).toHaveLength(1)
    expect(body.files[0]).toMatchObject({ key: publicKey, originalName: 'report.txt' })
  })
})

describe('file listing pagination', () => {
  const listedObject = (key: string) => ({
    key,
    size: 12,
    uploaded: new Date('2026-08-14T00:00:00Z'),
  })
  async function listBody(
    listHandler: ReturnType<typeof createScopedR2Handler>,
    listBucket: R2Bucket,
    query: string,
  ) {
    const url = new URL(`https://app.example/api/files?scope=app${query}`)
    const response = await listHandler(new Request(url), url, listBucket, { userId: 'user-1' })
    return (await response.json()) as {
      files: Array<{ key: string; relativeKey?: string }>
      truncated: boolean
      cursor?: string
    }
  }

  it("carries R2's cursor while truncated, and ?cursor= resumes exactly there", async () => {
    const calls: R2ListOptions[] = []
    const pagedBucket = {
      async list(options: R2ListOptions = {}) {
        calls.push(options)
        return options.cursor === 'cursor-1'
          ? { objects: [listedObject(`${PREFIX}b.txt`)], truncated: false }
          : { objects: [listedObject(`${PREFIX}a.txt`)], truncated: true, cursor: 'cursor-1' }
      },
    } as unknown as R2Bucket
    const listHandler = createScopedR2Handler({ resolvePrefix: () => ({ prefix: PREFIX }) })

    const first = await listBody(listHandler, pagedBucket, '&limit=1')
    expect(first).toMatchObject({ truncated: true, cursor: 'cursor-1' })
    // Entries carry the key both ways: absolute for downloads, relative for
    // same-scope calls (list prefixes, `?key=` upserts) that never see the prefix.
    expect(first.files).toEqual([
      expect.objectContaining({ key: `${PREFIX}a.txt`, relativeKey: 'a.txt' }),
    ])

    const second = await listBody(listHandler, pagedBucket, '&limit=1&cursor=cursor-1')
    expect(calls.at(-1)).toMatchObject({ cursor: 'cursor-1' })
    expect(second.files).toEqual([
      expect.objectContaining({ key: `${PREFIX}b.txt`, relativeKey: 'b.txt' }),
    ])
    expect(second.truncated).toBe(false)
    expect('cursor' in second).toBe(false)
  })

  it("reports the exclusion jump's continuation, not the page it jumped from", async () => {
    // The private subtree occupied the first page, so the handler jumps past
    // it. The jump is itself truncated — the caller must resume from the
    // JUMP's cursor; the pre-jump cursor would walk back into private keys.
    const jumpBucket = {
      async list(options: R2ListOptions = {}) {
        return options.startAfter
          ? {
              objects: [listedObject(`${PREFIX}visible/b.txt`)],
              truncated: true,
              cursor: 'after-1',
            }
          : {
              objects: [listedObject(`${PREFIX}private/a.txt`)],
              truncated: true,
              cursor: 'first-1',
            }
      },
    } as unknown as R2Bucket
    const listHandler = createScopedR2Handler({
      resolvePrefix: () => ({ prefix: PREFIX, excludedPrefixes: [`${PREFIX}private/`] }),
    })
    const body = await listBody(listHandler, jumpBucket, '')
    expect(body.files).toEqual([
      expect.objectContaining({ key: `${PREFIX}visible/b.txt`, relativeKey: 'visible/b.txt' }),
    ])
    expect(body).toMatchObject({ truncated: true, cursor: 'after-1' })
  })

  it('does not rewind an exhausted continuation into the exclusion jump', async () => {
    // A later page can end (truncated: false) with fewer visible keys than the
    // limit. Jumping past the private subtree from there would re-list keys
    // earlier pages already returned — the jump exists only for truncated pages.
    const calls: R2ListOptions[] = []
    const exhaustedBucket = {
      async list(options: R2ListOptions = {}) {
        calls.push(options)
        return { objects: [], truncated: false }
      },
    } as unknown as R2Bucket
    const listHandler = createScopedR2Handler({
      resolvePrefix: () => ({ prefix: PREFIX, excludedPrefixes: [`${PREFIX}private/`] }),
    })
    const body = await listBody(listHandler, exhaustedBucket, '&cursor=cursor-2')
    expect(calls).toEqual([expect.objectContaining({ cursor: 'cursor-2' })])
    expect(body).toMatchObject({ files: [], truncated: false })
    expect('cursor' in body).toBe(false)
  })

  it('advances the jump frontier across multiple excluded subtrees', async () => {
    // With two private subtrees, the second jump must resume from where the
    // first jump ended — restarting from the original page's tail would set
    // startAfter to the second subtree's boundary, which can sort BEFORE the
    // first jump's coverage and re-return keys it already delivered.
    const calls: R2ListOptions[] = []
    const firstJumpTail = `${PREFIX}z-visible/k1.txt`
    const bucket = {
      async list(options: R2ListOptions = {}) {
        calls.push(options)
        if (calls.length === 1)
          return {
            objects: [listedObject(`${PREFIX}a-private/a.txt`)],
            truncated: true,
            cursor: 'first',
          }
        if (calls.length === 2)
          return { objects: [listedObject(firstJumpTail)], truncated: true, cursor: 'jump-1' }
        return { objects: [], truncated: false }
      },
    } as unknown as R2Bucket
    const listHandler = createScopedR2Handler({
      resolvePrefix: () => ({
        prefix: PREFIX,
        excludedPrefixes: [`${PREFIX}a-private/`, `${PREFIX}b-private/`],
      }),
    })
    const body = await listBody(listHandler, bucket, '&limit=10')
    expect(calls).toHaveLength(3)
    expect(calls[2].startAfter).toBe(firstJumpTail)
    expect(body.files).toEqual([expect.objectContaining({ key: firstJumpTail })])
  })
})

describe('stored-file responses', () => {
  it('name the key both absolutely and relative to the scope', async () => {
    const stored = {
      head: async () => null,
      put: async () => ({ etag: 'etag-1' }),
    } as unknown as R2Bucket
    const url = new URL('https://app.example/api/files/upload?scope=app&key=showcase/report.csv')
    const body = JSON.stringify({ data: 'QQ==', name: 'report.csv' })
    const request = new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(new TextEncoder().encode(body).byteLength),
      },
      body,
    })
    const response = await handler(request, url, stored, { userId: 'user-1' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      success: true,
      key: `${PREFIX}showcase/report.csv`,
      relativeKey: 'showcase/report.csv',
    })
  })
})

describe('download responses', () => {
  const body = new TextEncoder().encode('0123456789abcdefghij') // 20 bytes
  const key = `${PREFIX}media/clip.mp3`

  /**
   * The handler parses `Range` itself and hands R2 an explicit
   * `{ offset, length }`; this bucket only serves what it is asked for, so the
   * `get` spy is the assertion about what was asked.
   */
  function storedBucket(contentType: string, replacement?: { body: typeof body; etag: string }) {
    let current = { body, etag: 'etag-1' }
    const object = () => ({
      size: current.body.length,
      etag: current.etag,
      httpEtag: `"${current.etag}"`,
      httpMetadata: { contentType },
      customMetadata: { originalName: 'clip.mp3' },
    })
    const head = vi.fn(async () => {
      const result = object()
      if (replacement) current = replacement
      return result
    })
    const get = vi.fn(async (_key: string, options?: R2GetOptions) => {
      const onlyIf = options?.onlyIf as R2Conditional | undefined
      if (onlyIf?.etagMatches && onlyIf.etagMatches !== current.etag) return object()
      const range = options?.range as { offset: number; length: number } | undefined
      const served = range
        ? current.body.slice(range.offset, range.offset + range.length)
        : current.body
      return { ...object(), body: new Blob([served]).stream() }
    })
    return { bucket: { head, get } as unknown as R2Bucket, head, get }
  }

  async function download(
    method: 'GET' | 'HEAD',
    headers: Record<string, string> = {},
    contentType = 'audio/mpeg',
    scope: 'self' | 'app' = 'self',
  ) {
    const url = new URL(`https://app.example/api/files/${key}?scope=${scope}`)
    const { bucket, head, get } = storedBucket(contentType)
    const res = await handler(new Request(url, { method, headers }), url, bucket, {
      userId: 'user-1',
    })
    return { res, head, get }
  }

  it('answers a plain GET whole, with no extra head call, and advertises byte ranges', async () => {
    const { res, head, get } = await download('GET')
    expect(res.status).toBe(200)
    expect(res.headers.get('Accept-Ranges')).toBe('bytes')
    expect(res.headers.get('Content-Length')).toBe('20')
    expect(res.headers.get('Content-Range')).toBeNull()
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await res.text()).toBe('0123456789abcdefghij')
    expect(head).not.toHaveBeenCalled()
    expect(get).toHaveBeenCalledWith(key)
  })

  it.each([
    ['bytes=0-9', 'bytes 0-9/20', { offset: 0, length: 10 }, '0123456789'],
    ['bytes=15-', 'bytes 15-19/20', { offset: 15, length: 5 }, 'fghij'],
    ['bytes=15-100', 'bytes 15-19/20', { offset: 15, length: 5 }, 'fghij'],
    ['bytes=-5', 'bytes 15-19/20', { offset: 15, length: 5 }, 'fghij'],
    ['bytes=-50', 'bytes 0-19/20', { offset: 0, length: 20 }, '0123456789abcdefghij'],
  ])('serves %s as 206 with an explicit R2 range', async (range, contentRange, r2Range, text) => {
    const { res, get } = await download('GET', { range })
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe(contentRange)
    expect(res.headers.get('Content-Length')).toBe(String(r2Range.length))
    expect(res.headers.get('Accept-Ranges')).toBe('bytes')
    expect(await res.text()).toBe(text)
    expect(get).toHaveBeenCalledWith(key, {
      range: r2Range,
      onlyIf: { etagMatches: 'etag-1' },
    })
  })

  it.each(['bytes=100-200', 'bytes=20-', 'bytes=-0'])(
    'refuses unsatisfiable %s with 416 and the size, without fetching the object',
    async (range) => {
      const { res, get } = await download('GET', { range })
      expect(res.status).toBe(416)
      expect(res.headers.get('Content-Range')).toBe('bytes */20')
      expect(await res.text()).toBe('')
      expect(get).not.toHaveBeenCalled()
    },
  )

  it.each(['bytes=abc', 'bytes=0-1,5-9', 'bytes=9-5', 'bytes=-', 'chars=0-1'])(
    'ignores %s (malformed or multi-range) and serves the whole object',
    async (range) => {
      const { res, get } = await download('GET', { range })
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Range')).toBeNull()
      expect(res.headers.get('Content-Length')).toBe('20')
      expect(await res.text()).toBe('0123456789abcdefghij')
      expect(get).toHaveBeenCalledWith(key)
    },
  )

  it('serves the seek under a matching If-Range and the whole object under a stale one', async () => {
    const { res: fresh } = await download('GET', { range: 'bytes=5-9', 'if-range': '"etag-1"' })
    expect(fresh.status).toBe(206)
    expect(fresh.headers.get('Content-Range')).toBe('bytes 5-9/20')

    // The key was replaced mid-playback: the browser's validator is stale.
    for (const range of ['bytes=5-9', 'bytes=100-200']) {
      const { res, get } = await download('GET', { range, 'if-range': '"etag-0"' })
      expect(res.status, range).toBe(200)
      expect(res.headers.get('Content-Range')).toBeNull()
      expect(await res.text()).toBe('0123456789abcdefghij')
      expect(get).toHaveBeenCalledWith(key)
    }
  })

  it('falls back to the whole new object when an upsert races the ranged read', async () => {
    const replacementBody = new TextEncoder().encode('replacement-media-contents')
    const url = new URL(`https://app.example/api/files/${key}?scope=self`)
    const { bucket, get } = storedBucket('audio/mpeg', {
      body: replacementBody,
      etag: 'etag-2',
    })
    const res = await handler(
      new Request(url, { headers: { range: 'bytes=5-9', 'if-range': '"etag-1"' } }),
      url,
      bucket,
      { userId: 'user-1' },
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('ETag')).toBe('"etag-2"')
    expect(res.headers.get('Content-Range')).toBeNull()
    expect(res.headers.get('Content-Length')).toBe(String(replacementBody.length))
    expect(await res.text()).toBe('replacement-media-contents')
    expect(get).toHaveBeenNthCalledWith(1, key, {
      range: { offset: 5, length: 5 },
      onlyIf: { etagMatches: 'etag-1' },
    })
    expect(get).toHaveBeenNthCalledWith(2, key)
  })

  it('answers HEAD with the GET headers and no body', async () => {
    const [{ res: head }, { res: get }] = await Promise.all([download('HEAD'), download('GET')])
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    for (const name of [
      'Content-Type',
      'Content-Length',
      'Accept-Ranges',
      'ETag',
      'Cache-Control',
    ]) {
      expect(head.headers.get(name), name).toBe(get.headers.get(name))
    }
    const {
      res: ranged,
      head: rangedHead,
      get: rangedGet,
    } = await download('HEAD', {
      range: 'bytes=5-9',
    })
    expect(ranged.status).toBe(200)
    expect(ranged.headers.get('Content-Range')).toBeNull()
    expect(ranged.headers.get('Content-Length')).toBe('20')
    expect(await ranged.text()).toBe('')
    expect(rangedHead).toHaveBeenCalledWith(key)
    expect(rangedGet).not.toHaveBeenCalled()
  })

  it('keeps forcing active content to a sandboxed attachment on HEAD and 206', async () => {
    for (const { res } of [
      await download('HEAD', {}, 'text/html'),
      await download('GET', { range: 'bytes=0-1' }, 'text/html'),
    ]) {
      expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('Content-Disposition')).toMatch(/^attachment;/)
      expect(res.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'")
    }
  })

  it('still revalidates app-scope downloads by ETag', async () => {
    const { res } = await download('GET', { 'if-none-match': '"etag-1"' }, 'audio/mpeg', 'app')
    expect(res.status).toBe(304)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate')
    expect(await res.text()).toBe('')
  })

  it('evaluates If-None-Match before an unsatisfiable Range', async () => {
    const { res, get } = await download(
      'GET',
      { range: 'bytes=100-200', 'if-none-match': '"etag-1"' },
      'audio/mpeg',
      'app',
    )
    expect(res.status).toBe(304)
    expect(res.headers.get('Content-Range')).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })
})
