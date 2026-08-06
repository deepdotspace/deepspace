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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/api'
import {
  MAX_APP_FILE_BYTES,
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
    expect(relativeKey(`apps/${APP}/weird\nname.txt`, appPrefixOf(`apps/${APP}/weird\nname.txt`))).toBe(
      'weird\nname.txt',
    )
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
      reply = { status: 200, body: JSON.stringify({ key: `apps/${APP}/hero.png`, name: 'hero.png' }) }

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

    it('refuses an over-cap file before opening a socket', async () => {
      const local = join(workdir, 'huge.bin')
      writeFileSync(local, Buffer.alloc(MAX_APP_FILE_BYTES + 1))
      captured = null
      await expect(uploadAppFile(baseUrl, 'tok', APP, local, 'huge.bin')).rejects.toMatchObject({
        code: 'file_too_large',
      })
      expect(captured).toBeNull()
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
      expect(err.code).toBe('file_too_large')
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
