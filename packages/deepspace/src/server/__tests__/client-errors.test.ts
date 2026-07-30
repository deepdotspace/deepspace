import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handleClientErrorReport,
  resetClientErrorThrottle,
  shouldThrottleClientError,
} from '../client-errors'
import { CLIENT_LOG_MARKER } from '../../shared/client-errors'

function report(body: unknown): Request {
  return new Request('https://app.test/_deepspace/client-errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  resetClientErrorThrottle()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
})

describe('handleClientErrorReport', () => {
  it('logs a marker-prefixed line and returns 204 for a valid report', async () => {
    const res = await handleClientErrorReport(
      report({ kind: 'error', name: 'TypeError', message: 'boom', stack: 'TypeError: boom\n  at x' }),
    )
    expect(res.status).toBe(204)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const line = errorSpy.mock.calls[0][0] as string
    expect(line.startsWith(CLIENT_LOG_MARKER)).toBe(true)
    expect(JSON.parse(line.slice(CLIENT_LOG_MARKER.length).trim())).toMatchObject({
      kind: 'error',
      name: 'TypeError',
      message: 'boom',
    })
  })

  it('400s an unparseable body without logging', async () => {
    const req = new Request('https://app.test/_deepspace/client-errors', {
      method: 'POST',
      body: 'not json{',
    })
    const res = await handleClientErrorReport(req)
    expect(res.status).toBe(400)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('400s an empty/useless report without logging', async () => {
    const res = await handleClientErrorReport(report({ message: '', stack: '' }))
    expect(res.status).toBe(400)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('caps oversized fields so the emitted line stays well under the 256 KB CF cap', async () => {
    const big = 'z'.repeat(50_000)
    const res = await handleClientErrorReport(report({ message: big, stack: big }))
    expect(res.status).toBe(204)
    const line = errorSpy.mock.calls[0][0] as string
    expect(new TextEncoder().encode(line).length).toBeLessThan(256 * 1024)
  })

  it('413s an oversized body before parsing or logging', async () => {
    // Rejected on the inbound Content-Length header alone, before `.json()`.
    // (node's Request doesn't surface content-length; CF Workers inbound
    // requests + browser fetch do — so drive the guard with an explicit header.)
    const oversized = {
      headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(100 * 1024) : null) },
      json: async () => ({ message: 'should never be parsed' }),
    } as unknown as Request
    const res = await handleClientErrorReport(oversized)
    expect(res.status).toBe(413)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('403s a cross-site/same-site fetch but allows same-origin and absent', async () => {
    const withSite = (site: string) =>
      new Request('https://app.test/_deepspace/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': site },
        body: JSON.stringify({ message: 'm' }),
      })
    expect((await handleClientErrorReport(withSite('cross-site'))).status).toBe(403)
    expect((await handleClientErrorReport(withSite('same-site'))).status).toBe(403)
    expect(errorSpy).not.toHaveBeenCalled()
    expect((await handleClientErrorReport(withSite('same-origin'))).status).toBe(204)
    // Absent header (non-browser / older browser) is allowed.
    expect((await handleClientErrorReport(report({ message: 'm2' }))).status).toBe(204)
  })

  it('429s once the per-isolate window is exhausted', async () => {
    // First 20 in the window pass, the 21st is throttled.
    for (let i = 0; i < 20; i++) {
      expect((await handleClientErrorReport(report({ message: `m${i}` }))).status).toBe(204)
    }
    const throttled = await handleClientErrorReport(report({ message: 'overflow' }))
    expect(throttled.status).toBe(429)
    expect(throttled.headers.get('Retry-After')).toBe('1')
  })
})

describe('shouldThrottleClientError', () => {
  it('resets the count when the window rolls over', () => {
    resetClientErrorThrottle()
    for (let i = 0; i < 20; i++) expect(shouldThrottleClientError(1000)).toBe(false)
    expect(shouldThrottleClientError(1000)).toBe(true)
    // A later timestamp past the window starts a fresh count.
    expect(shouldThrottleClientError(2500)).toBe(false)
  })
})
