/**
 * `deepspace app files` — key rules, rendering, and the upload/download
 * transport.
 *
 * The transport half runs against a real local HTTP server rather than a
 * stubbed fetch: what is worth pinning is the wire contract (a parseable
 * multipart body, an exact Content-Length, a streamed download, and the
 * shared coded-error shape), and none of that survives a stub.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/api'
import {
  MAX_APP_FILE_BYTES,
  UPLOAD_PART_BYTES,
  contentTypeFor,
  downloadAppFile,
  encodeKeyPath,
  filesPath,
  formatBytes,
  uploadAppFile,
} from '../../lib/app-files-api'
import { appPrefixOf, relativeKey, requireKey, servedPath } from '../app-files'

const APP = 'app_00000000000000000000000F1A'

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('requireKey', () => {
  it('accepts a plain and a nested key', () => {
    expect(requireKey('logo.png')).toBe('logo.png')
    expect(requireKey('img/hero.jpg')).toBe('img/hero.jpg')
  })

  it('strips a leading slash rather than sending an empty first segment', () => {
    expect(requireKey('/logo.png')).toBe('logo.png')
  })

  it('refuses an empty key with a coded refusal', () => {
    expect(() => requireKey('   ')).toThrow(/key is required/)
  })

  it('refuses traversal segments before they reach the server', () => {
    for (const bad of ['../other/x', 'img/../../x', './x']) {
      expect(() => requireKey(bad), bad).toThrow(/traversal/)
    }
  })

  it('allows dots inside a name, which are not traversal', () => {
    expect(requireKey('my.file.v2.png')).toBe('my.file.v2.png')
  })
})

describe('contentTypeFor', () => {
  it('names common media types and is case-insensitive', () => {
    expect(contentTypeFor('/a/b/logo.PNG')).toBe('image/png')
    expect(contentTypeFor('hero.webp')).toBe('image/webp')
  })

  it('falls back to octet-stream for anything unlisted', () => {
    expect(contentTypeFor('mystery.qqq')).toBe('application/octet-stream')
    expect(contentTypeFor('noextension')).toBe('application/octet-stream')
  })
})

describe('key rendering', () => {
  it('takes the mounted prefix by segment, not by pattern', () => {
    expect(appPrefixOf(`apps/${APP}/img/hero.jpg`)).toBe(`apps/${APP}/`)
    // A key may contain any character. A regex anchored with `.*` silently
    // fails to match one containing a newline and would leak the absolute key.
    expect(appPrefixOf(`apps/${APP}/weird\nname.txt`)).toBe(`apps/${APP}/`)
    // A migrated app's physical locator is not an app id at all.
    expect(appPrefixOf('apps/legacy-files/logo.png')).toBe('apps/legacy-files/')
    // Nothing to strip.
    expect(appPrefixOf('logo.png')).toBe('')
  })

  it('shows listings relative to the mounted prefix', () => {
    expect(relativeKey(`apps/${APP}/img/hero.jpg`, `apps/${APP}/`)).toBe('img/hero.jpg')
    expect(
      relativeKey(`apps/${APP}/weird\nname.txt`, appPrefixOf(`apps/${APP}/weird\nname.txt`)),
    ).toBe('weird\nname.txt')
  })

  it('leaves a key alone when it does not carry the prefix', () => {
    expect(relativeKey('img/hero.jpg', `apps/${APP}/`)).toBe('img/hero.jpg')
  })

  it('serves from the app origin at app scope, with each segment encoded', () => {
    expect(servedPath(`apps/${APP}/a b.png`)).toBe(`/api/files/apps/${APP}/a%20b.png?scope=app`)
  })

  it('keeps key hierarchy while encoding reserved characters', () => {
    expect(encodeKeyPath('img/a?b#c.png')).toBe('img/a%3Fb%23c.png')
  })

  it('builds the owner route path', () => {
    expect(filesPath(APP)).toBe(`/api/app-files/${APP}`)
    expect(filesPath(APP, '/logo.png')).toBe(`/api/app-files/${APP}/logo.png`)
  })
})

describe('formatBytes', () => {
  it('scales through B, KiB and MiB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KiB')
    expect(formatBytes(21 * 1024 * 1024)).toBe('21.0 MiB')
  })
})

// ── Transport ────────────────────────────────────────────────────────────────

interface Captured {
  method: string
  url: string
  contentLength: string | null
  transferEncoding: string | null
  contentType: string | null
  authorization: string | null
  body: Buffer
}

describe('app files transport', () => {
  let server: Server
  let baseUrl: string
  let workdir: string
  let captured: Captured | null = null
  /** Set per-test to steer the fake platform's reply. */
  let reply: { status: number; headers?: Record<string, string>; body: string | Buffer } = {
    status: 200,
    body: '{}',
  }

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'deepspace-app-files-'))
    server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        captured = {
          method: req.method ?? '',
          url: req.url ?? '',
          contentLength: req.headers['content-length'] ?? null,
          transferEncoding: req.headers['transfer-encoding'] ?? null,
          contentType: req.headers['content-type'] ?? null,
          authorization: req.headers['authorization'] ?? null,
          body: Buffer.concat(chunks),
        }
        res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers })
        res.end(reply.body)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.close()
    rmSync(workdir, { recursive: true, force: true })
  })

  describe('upload', () => {
    it('sends a parseable multipart body under an exact Content-Length', async () => {
      const local = join(workdir, 'hero.png')
      const contents = Buffer.alloc(64 * 1024, 9)
      writeFileSync(local, contents)
      reply = {
        status: 200,
        body: JSON.stringify({ key: `apps/${APP}/hero.png`, name: 'hero.png' }),
      }

      const result = await uploadAppFile(baseUrl, 'tok', APP, local, 'hero.png')
      expect(result).toMatchObject({ key: `apps/${APP}/hero.png`, size: contents.length })

      expect(captured!.method).toBe('POST')
      expect(captured!.url).toBe(`/api/app-files/${APP}/upload?key=hero.png`)
      expect(captured!.authorization).toBe('Bearer tok')
      // Length-delimited, not chunked — the point of composing the body as a
      // Blob rather than a FormData generator.
      expect(captured!.transferEncoding).toBeNull()
      expect(Number(captured!.contentLength)).toBe(captured!.body.length)

      // The bytes on the wire really are multipart/form-data with the file
      // intact under the `file` field.
      const parsed = await new Response(new Uint8Array(captured!.body), {
        headers: { 'content-type': captured!.contentType! },
      }).formData()
      const part = parsed.get('file') as File
      expect(part.name).toBe('hero.png')
      expect(part.type).toBe('image/png')
      expect(Buffer.from(await part.arrayBuffer()).equals(contents)).toBe(true)
    })

    it('encodes a nested key into the query without losing its hierarchy', async () => {
      const local = join(workdir, 'a.txt')
      writeFileSync(local, 'x')
      reply = { status: 200, body: JSON.stringify({ key: 'k', name: 'a.txt' }) }
      await uploadAppFile(baseUrl, 'tok', APP, local, 'img/hero shot.png')
      expect(captured!.url).toBe(`/api/app-files/${APP}/upload?key=img/hero%20shot.png`)
    })

    it('refuses an over-ceiling file before opening a socket', async () => {
      const local = join(workdir, 'huge.bin')
      // Sparse: the check reads `statSync().size`, and writing a real gibibyte
      // to assert that a size check happens before any read would be silly.
      writeFileSync(local, '')
      truncateSync(local, MAX_APP_FILE_BYTES + 1)
      captured = null
      await expect(uploadAppFile(baseUrl, 'tok', APP, local, 'huge.bin')).rejects.toMatchObject({
        code: 'too_large',
      })
      expect(captured).toBeNull()
    })

    it.each([
      ['logo.svg', 'image/svg+xml'],
      ['page.html', 'text/html'],
      ['app.js', 'text/javascript'],
    ])('uploads %s with its real downloadable media type', async (name, mime) => {
      const local = join(workdir, name)
      writeFileSync(local, 'x')
      reply = { status: 200, body: JSON.stringify({ key: `apps/${APP}/${name}`, name }) }
      await uploadAppFile(baseUrl, 'tok', APP, local, name)
      const parsed = await new Response(new Uint8Array(captured!.body), {
        headers: { 'content-type': captured!.contentType! },
      }).formData()
      expect((parsed.get('file') as File).type).toBe(mime)
    })

    it('sends a file at exactly the part size in ONE request', async () => {
      const local = join(workdir, 'exact.bin')
      writeFileSync(local, '')
      truncateSync(local, UPLOAD_PART_BYTES)
      reply = { status: 200, body: JSON.stringify({ key: 'k', name: 'exact.bin' }) }
      const result = await uploadAppFile(baseUrl, 'tok', APP, local, 'exact.bin')
      expect(result.parts).toBe(1)
      expect(captured!.url).toBe(`/api/app-files/${APP}/upload?key=exact.bin`)
    })

    it('reports an edge HTML 413 as a size limit, not a JSON parse error', async () => {
      const local = join(workdir, 'ok.txt')
      writeFileSync(local, 'x')
      // What Cloudflare actually returns when the body exceeds its request
      // limit: an HTML page, produced before any worker code runs.
      reply = {
        status: 413,
        headers: { 'content-type': 'text/html' },
        body: '<!DOCTYPE html><html><head><title>413 Request Entity Too Large</title></head><body>...</body></html>',
      }
      const err = await uploadAppFile(baseUrl, 'tok', APP, local, 'ok.txt').catch((e) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect(err.code).toBe('too_large')
      expect(err.message).toContain('too large')
      expect(err.message).toContain(formatBytes(MAX_APP_FILE_BYTES))
      expect(err.message).not.toContain('<')
      expect(err.message).not.toMatch(/JSON|Unexpected token/i)
    })

    it('surfaces the server’s code and sentence on a refusal', async () => {
      const local = join(workdir, 'evil.txt')
      writeFileSync(local, 'x')
      reply = {
        status: 415,
        body: JSON.stringify({ error: 'Unsupported media type: text/html' }),
      }
      const err = await uploadAppFile(baseUrl, 'tok', APP, local, 'evil.html').catch((e) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect(err.status).toBe(415)
      expect(err.message).toContain('Unsupported media type')
    })
  })

  describe('download', () => {
    it('streams the body to disk byte-for-byte', async () => {
      const payload = Buffer.alloc(300 * 1024, 3)
      reply = { status: 200, headers: { 'content-type': 'image/png' }, body: payload }
      const out = join(workdir, 'downloaded.png')

      const result = await downloadAppFile(baseUrl, 'tok', APP, 'img/hero.png', out)
      expect(result).toMatchObject({ bytes: payload.length, contentType: 'image/png' })
      expect(readFileSync(out).equals(payload)).toBe(true)
      expect(captured!.method).toBe('GET')
      expect(captured!.url).toBe(`/api/app-files/${APP}/img/hero.png`)
    })

    it('gives an honest error when a 2xx body is not JSON', async () => {
      const local = join(workdir, 'ok2.txt')
      writeFileSync(local, 'x')
      reply = { status: 200, body: 'not json at all' }
      const err = await uploadAppFile(baseUrl, 'tok', APP, local, 'ok2.txt').catch((e) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect(err.code).toBe('invalid_response')
      expect(err.message).not.toMatch(/Unexpected token/i)
    })

    it('raises the shared coded error for a missing key', async () => {
      reply = { status: 404, body: JSON.stringify({ error: 'File not found' }) }
      const err = await downloadAppFile(
        baseUrl,
        'tok',
        APP,
        'gone.png',
        join(workdir, 'gone.png'),
      ).catch((e) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect(err.status).toBe(404)
      expect(err.code).toBe('http_error')
    })

    it('codes an unreachable platform as a network error, not a status', async () => {
      const err = await downloadAppFile(
        'http://127.0.0.1:1',
        'tok',
        APP,
        'x.png',
        join(workdir, 'x.png'),
      ).catch((e) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect(err.code).toBe('network_error')
      expect(err.message).toContain('DEEPSPACE_PLATFORM_URL')
    })
  })
})

/**
 * The chunked upload path.
 *
 * Against a real HTTP server that plays the whole protocol, because the claims
 * worth pinning are wire claims: that each part carries an exact
 * Content-Length rather than going out chunked, that the parts reassemble into
 * the original file byte-for-byte, and that a failure abandons the session
 * instead of leaving parts holding the customer's quota.
 */
describe('app files chunked upload', () => {
  interface Seen {
    method: string
    url: string
    contentLength: string | null
    transferEncoding: string | null
    body: Buffer
  }

  let server: Server
  let baseUrl: string
  let workdir: string
  let seen: Seen[] = []
  /** The fake platform's behaviour, reset per test. */
  let behaviour: {
    partSize: number
    failPart?: number
    failComplete?: boolean
    failInit?: boolean
    flakyInit?: boolean
    /** Fail this part with this status, but only on its FIRST attempt. */
    flakyPart?: { partNumber: number; status: number }
  }

  const SERVER_PART_SIZE = UPLOAD_PART_BYTES

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'deepspace-app-files-mpu-'))
    server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const url = req.url ?? ''
        const body = Buffer.concat(chunks)
        seen.push({
          method: req.method ?? '',
          url,
          contentLength: req.headers['content-length'] ?? null,
          transferEncoding: req.headers['transfer-encoding'] ?? null,
          body,
        })
        const json = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(payload))
        }
        const params = new URL(url, 'http://x').searchParams
        if (url.includes('/multipart/part')) {
          const partNumber = Number(params.get('partNumber'))
          if (behaviour.failPart === partNumber) return json(503, { error: 'part exploded' })
          const flaky = behaviour.flakyPart
          if (flaky?.partNumber === partNumber) {
            const already = seen.filter(
              (s) =>
                s.url.includes('/multipart/part') && s.url.includes(`partNumber=${partNumber}`),
            ).length
            // `seen` already includes this attempt, so 1 means first try.
            if (already <= 1) return json(flaky.status, { error: 'flaky', code: 'server_error' })
          }
          return json(200, { partNumber, etag: `etag-${partNumber}` })
        }
        if (url.includes('/multipart/complete')) {
          return behaviour.failComplete
            ? json(400, { error: 'assembly failed', code: 'bad_parts' })
            : json(200, { key: `apps/${APP}/big.mp4`, name: 'big.mp4' })
        }
        if (url.includes('/multipart')) {
          if (req.method === 'DELETE') return json(200, { success: true, aborted: true })
          const initAttempts = seen.filter(
            (request) =>
              request.method === 'POST' &&
              new URL(request.url, 'http://x').pathname.endsWith('/multipart'),
          ).length
          if (behaviour.flakyInit && initAttempts === 1) {
            return json(503, { error: 'temporary', code: 'server_error' })
          }
          return behaviour.failInit
            ? json(413, { error: 'That file is 1.5 GiB; the limit is 1.0 GiB per file.' })
            : json(200, {
                uploadId: 'up-9',
                uploadKey: params.get('key') ?? 'generated.mp4',
                reservationId: 'reservation-cli-9',
                partSize: behaviour.partSize,
              })
        }
        return json(200, { key: 'single', name: 'single' })
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.close()
    rmSync(workdir, { recursive: true, force: true })
  })

  beforeEach(() => {
    seen = []
    behaviour = { partSize: SERVER_PART_SIZE }
  })

  /** A file just past the single-request bound, with recognisable content. */
  function bigFile(name = 'big.mp4'): { path: string; contents: Buffer } {
    const contents = Buffer.alloc(UPLOAD_PART_BYTES + 1024)
    for (let i = 0; i < contents.length; i++) contents[i] = i % 251
    const path = join(workdir, name)
    writeFileSync(path, contents)
    return { path, contents }
  }

  it('runs init → parts → complete and reassembles the file byte-for-byte', async () => {
    const { path, contents } = bigFile()
    const result = await uploadAppFile(baseUrl, 'tok', APP, path, 'video/big.mp4')

    const expectedParts = Math.ceil(contents.length / SERVER_PART_SIZE)
    expect(result).toMatchObject({
      key: `apps/${APP}/big.mp4`,
      size: contents.length,
      parts: expectedParts,
    })
    expect(seen.map((s) => `${s.method} ${s.url.split('?')[0]}`)).toEqual([
      `POST /api/app-files/${APP}/multipart`,
      ...Array(expectedParts).fill(`PUT /api/app-files/${APP}/multipart/part`),
      `POST /api/app-files/${APP}/multipart/complete`,
    ])

    // Init declares the total before a byte moves, and keeps the key nested.
    expect(seen[0].url).toBe(`/api/app-files/${APP}/multipart?key=video/big.mp4`)
    const initBody = JSON.parse(seen[0].body.toString()) as Record<string, unknown>
    expect(initBody).toMatchObject({
      name: 'big.mp4',
      mimeType: 'video/mp4',
      size: contents.length,
    })
    expect(initBody.requestId).toEqual(expect.any(String))

    const parts = seen.slice(1, 1 + expectedParts)
    parts.forEach((part, index) => {
      const params = new URL(part.url, 'http://x').searchParams
      expect(params.get('uploadKey')).toBe('video/big.mp4')
      expect(params.get('uploadId')).toBe('up-9')
      expect(params.get('reservationId')).toBe('reservation-cli-9')
      expect(Number(params.get('partNumber'))).toBe(index + 1)
      // Length-delimited, never chunked: the server requires a Content-Length
      // and a stream body would arrive without one.
      expect(part.transferEncoding).toBeNull()
      expect(Number(part.contentLength)).toBe(part.body.length)
    })
    // Every part but the last is exactly the advertised size — R2's rule.
    for (const part of parts.slice(0, -1)) expect(part.body.length).toBe(SERVER_PART_SIZE)
    expect(Buffer.concat(parts.map((p) => p.body)).equals(contents)).toBe(true)

    expect(JSON.parse(seen.at(-1)!.body.toString())).toEqual({
      parts: parts.map((_, index) => ({ partNumber: index + 1, etag: `etag-${index + 1}` })),
    })
  })

  it('refuses a server response that disagrees with the fixed layout', async () => {
    behaviour.partSize = 5 * 1024 * 1024
    const { path } = bigFile('server-size.mp4')
    const error = await uploadAppFile(baseUrl, 'tok', APP, path, 'server-size.mp4').catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('invalid_response')
    expect(seen.filter((request) => request.url.includes('/multipart/part'))).toHaveLength(0)
  })

  it('aborts the session when a part fails, and raises the part’s error', async () => {
    behaviour.failPart = 2
    const { path } = bigFile('fail-part.mp4')
    const err = await uploadAppFile(baseUrl, 'tok', APP, path, 'fail-part.mp4').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toBe('part exploded')
    // Three part requests: part 1, then part 2 twice — retried once because
    // 503 is retryable, then given up on. Part 3 is never attempted, and the
    // parts that landed are released.
    expect(seen.filter((s) => s.url.includes('/multipart/part'))).toHaveLength(3)
    expect(seen.filter((s) => s.url.includes('partNumber=3'))).toHaveLength(0)
    expect(seen.at(-1)).toMatchObject({ method: 'DELETE' })
    expect(seen.at(-1)!.url).toContain('uploadId=up-9')
  })

  it('aborts when assembly fails — parts left behind would hold the quota', async () => {
    behaviour.failComplete = true
    const { path } = bigFile('fail-complete.mp4')
    const err = await uploadAppFile(baseUrl, 'tok', APP, path, 'fail-complete.mp4').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('bad_parts')
    expect(seen.at(-1)).toMatchObject({ method: 'DELETE' })
  })

  it('does not abort a completed upload', async () => {
    const { path } = bigFile('clean.mp4')
    await uploadAppFile(baseUrl, 'tok', APP, path, 'clean.mp4')
    expect(seen.some((s) => s.method === 'DELETE')).toBe(false)
  })

  it('stops at init when the server refuses the declared total', async () => {
    behaviour.failInit = true
    const { path } = bigFile('refused.mp4')
    const err = await uploadAppFile(baseUrl, 'tok', APP, path, 'refused.mp4').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toContain('the limit is 1.0 GiB per file')
    // No parts, and nothing to abort — the session was never created.
    expect(seen).toHaveLength(1)
  })

  it('retries a transient init with the same request id', async () => {
    behaviour.flakyInit = true
    const { path } = bigFile('retry-init.mp4')
    await uploadAppFile(baseUrl, 'tok', APP, path, 'retry-init.mp4')
    const inits = seen.filter(
      (request) =>
        request.method === 'POST' &&
        new URL(request.url, 'http://x').pathname.endsWith('/multipart'),
    )
    expect(inits).toHaveLength(2)
    const requestIds = inits.map(
      (request) => (JSON.parse(request.body.toString()) as { requestId: string }).requestId,
    )
    expect(new Set(requestIds).size).toBe(1)
  })

  it('reports progress after each part', async () => {
    const { path, contents } = bigFile('progress.mp4')
    const ticks: Array<[number, number, number, number]> = []
    await uploadAppFile(baseUrl, 'tok', APP, path, 'progress.mp4', (sent, total, part, parts) =>
      ticks.push([sent, total, part, parts]),
    )
    const expectedParts = Math.ceil(contents.length / SERVER_PART_SIZE)
    expect(ticks).toHaveLength(expectedParts)
    expect(ticks.at(-1)).toEqual([contents.length, contents.length, expectedParts, expectedParts])
    expect(ticks[0]).toEqual([SERVER_PART_SIZE, contents.length, 1, expectedParts])
  })

  it('retries a part ONCE on a retryable failure, re-reading the slice', async () => {
    behaviour.flakyPart = { partNumber: 2, status: 503 }
    const { path, contents } = bigFile('flaky.mp4')
    const result = await uploadAppFile(baseUrl, 'tok', APP, path, 'flaky.mp4')

    const expectedParts = Math.ceil(contents.length / SERVER_PART_SIZE)
    expect(result.parts).toBe(expectedParts)
    const partCalls = seen.filter((s) => s.url.includes('/multipart/part'))
    expect(partCalls).toHaveLength(expectedParts + 1)

    // Both attempts at part 2 carried the SAME bytes — a body is consumed
    // once, so the retry has to re-read the range rather than resend a
    // drained one. Without that the retry silently uploads nothing.
    const second = partCalls.filter((s) => s.url.includes('partNumber=2'))
    expect(second).toHaveLength(2)
    expect(second[0].body.length).toBe(second[1].body.length)
    expect(second[0].body.equals(second[1].body)).toBe(true)
    expect(seen.some((s) => s.method === 'DELETE')).toBe(false)
  })

  it('does not retry a refusal the server will repeat', async () => {
    // 4xx is the client's mistake; retrying spends another part upload to
    // reach the same answer.
    behaviour.flakyPart = { partNumber: 1, status: 415 }
    const { path } = bigFile('no-retry.mp4')
    await uploadAppFile(baseUrl, 'tok', APP, path, 'no-retry.mp4').catch((e) => e)
    expect(seen.filter((s) => s.url.includes('/multipart/part'))).toHaveLength(1)
    expect(seen.at(-1)).toMatchObject({ method: 'DELETE' })
  })

  it('refuses every non-canonical part size', async () => {
    for (const partSize of [0, -1, 5 * 1024 * 1024]) {
      seen = []
      behaviour = { partSize }
      const { path } = bigFile(`bad-part-size-${partSize}.mp4`)
      const err = await uploadAppFile(baseUrl, 'tok', APP, path, 'bad.mp4').catch((e) => e)
      expect(err, String(partSize)).toBeInstanceOf(ApiError)
      expect(err.code).toBe('invalid_response')
      expect(err.message).toContain('unusable part size')
      expect(seen.filter((s) => s.url.includes('/multipart/part'))).toHaveLength(0)
    }
  })
})
