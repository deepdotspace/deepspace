import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeOptionsWithOutboundHook, writeNodeOutboundHook } from '../node-outbound-hook'

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('node outbound preload', () => {
  it('writes a private Wrangler boundary patch in app-local state', () => {
    dir = mkdtempSync(join(tmpdir(), 'ds-outbound-hook-'))
    const path = writeNodeOutboundHook(dir)
    expect(existsSync(path)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('keeps its content when rewritten so concurrent runs share it', () => {
    dir = mkdtempSync(join(tmpdir(), 'ds-outbound-hook-'))
    const path = writeNodeOutboundHook(dir)
    const { mtimeMs } = statSync(path)
    expect(writeNodeOutboundHook(dir)).toBe(path)
    expect(statSync(path).mtimeMs).toBe(mtimeMs)
  })

  it('leaves Wrangler unloaded outside the Vite CLI', () => {
    dir = mkdtempSync(join(tmpdir(), 'ds-outbound-hook-'))
    const wrangler = join(dir, 'node_modules', 'wrangler')
    mkdirSync(wrangler, { recursive: true })
    writeFileSync(join(wrangler, 'index.js'), `throw new Error('wrangler loaded')`)
    const check = join(dir, 'playwright.mjs')
    writeFileSync(check, '')
    const hook = pathToFileURL(writeNodeOutboundHook(dir)).href
    execFileSync(process.execPath, ['--import', hook, check], { cwd: dir, stdio: 'pipe' })
  })

  it('bridges foreign requests without overriding an app-owned outbound service', () => {
    dir = mkdtempSync(join(tmpdir(), 'ds-outbound-hook-'))
    const wrangler = join(dir, 'node_modules', 'wrangler')
    mkdirSync(wrangler, { recursive: true })
    writeFileSync(
      join(wrangler, 'index.js'),
      `
      exports.unstable_getMiniflareWorkerOptions = (workerOptions = {}) => ({ workerOptions })
    `,
    )
    // Runs as the Vite CLI entry, the only process the preload patches.
    const vite = join(dir, 'node_modules', 'vite')
    mkdirSync(join(vite, 'bin'), { recursive: true })
    writeFileSync(join(vite, 'package.json'), '{"type":"module"}')
    const check = join(vite, 'bin', 'vite.js')
    writeFileSync(
      check,
      `
      import assert from 'node:assert/strict'
      import { createRequire } from 'node:module'
      const require = createRequire(import.meta.url)
      const getOptions = require('wrangler').unstable_getMiniflareWorkerOptions
      const existing = () => new Response('app-owned')
      assert.equal(getOptions({ outboundService: existing }).workerOptions.outboundService, existing)
      const service = getOptions().workerOptions.outboundService
      const body = new TextEncoder().encode('hello').buffer
      globalThis.fetch = async (url, init) => {
        assert.equal(url, 'https://auth.example.test/api/auth/test')
        assert.equal(init.method, 'POST')
        assert.equal(init.headers.get('content-type'), 'text/plain')
        assert.equal(init.redirect, 'manual')
        assert.equal(init.body, body)
        return new Response('forwarded')
      }
      const response = await service({
        url: 'https://auth.example.test/api/auth/test', method: 'POST', redirect: 'follow',
        headers: { forEach: (callback) => callback('text/plain', 'content-type') },
        arrayBuffer: async () => body,
      })
      assert.equal(await response.text(), 'forwarded')
    `,
    )
    const hook = pathToFileURL(writeNodeOutboundHook(dir)).href
    execFileSync(process.execPath, ['--import', hook, check], {
      cwd: dir,
      stdio: 'pipe',
      timeout: 10_000,
    })
  })

  it('preserves existing NODE_OPTIONS and imports the hook by file URL', () => {
    const path = join(tmpdir(), 'agent tools', 'hook.mjs')
    expect(nodeOptionsWithOutboundHook('--trace-warnings', path)).toBe(
      `--trace-warnings --import "${pathToFileURL(path).href}"`,
    )
    expect(nodeOptionsWithOutboundHook(undefined, path)).toMatch(/^--import "file:\/\/\//)
  })
})
