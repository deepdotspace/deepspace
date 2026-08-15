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

import { describe, expect, it } from 'vitest'
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
