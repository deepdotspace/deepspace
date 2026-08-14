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
