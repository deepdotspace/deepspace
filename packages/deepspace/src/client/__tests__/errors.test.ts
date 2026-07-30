/**
 * The reporter runs in the browser; the package's vitest env is node, so we
 * stand up a minimal fake `window` (event registry + location) and stub
 * `fetch`, then drive the real 'error'/'unhandledrejection' handlers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installClientErrorReporter, reportClientError } from '../errors'

type Handler = (event: unknown) => void

let handlers: Record<string, Handler[]>
let fetchMock: ReturnType<typeof vi.fn>
let uninstall: () => void

function emit(type: string, event: unknown) {
  for (const h of handlers[type] ?? []) h(event)
}

function bodyOf(callIndex: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit
  return JSON.parse(init.body as string)
}

beforeEach(() => {
  handlers = {}
  const fakeWindow = {
    addEventListener: (type: string, h: Handler) => {
      ;(handlers[type] ??= []).push(h)
    },
    removeEventListener: (type: string, h: Handler) => {
      handlers[type] = (handlers[type] ?? []).filter((x) => x !== h)
    },
    location: { href: 'https://app.test/page' },
  }
  ;(globalThis as unknown as { window: unknown }).window = fakeWindow
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
  ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock
  uninstall = () => {}
})

afterEach(() => {
  uninstall()
  delete (globalThis as unknown as { window?: unknown }).window
  vi.restoreAllMocks()
})

describe('installClientErrorReporter', () => {
  it('forwards an uncaught error to the ingestion endpoint', () => {
    uninstall = installClientErrorReporter()
    emit('error', {
      error: Object.assign(new TypeError('boom'), { stack: 'TypeError: boom\n  at h' }),
      message: 'boom',
      filename: 'https://app.test/app.js',
      lineno: 12,
      colno: 3,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/_deepspace/client-errors')
    expect(bodyOf(0)).toMatchObject({
      kind: 'error',
      name: 'TypeError',
      message: 'boom',
      url: 'https://app.test/app.js',
      line: 12,
      col: 3,
    })
  })

  it('forwards an unhandled rejection, stringifying a non-Error reason', () => {
    uninstall = installClientErrorReporter()
    emit('unhandledrejection', { reason: 'plain string rejection' })
    expect(bodyOf(0)).toMatchObject({
      kind: 'unhandledrejection',
      message: 'plain string rejection',
      url: 'https://app.test/page',
    })
  })

  it('dedupes identical errors within a page load', () => {
    uninstall = installClientErrorReporter()
    const event = { error: new Error('same'), message: 'same' }
    emit('error', event)
    emit('error', event)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caps how many reports it sends', () => {
    uninstall = installClientErrorReporter({ maxReports: 2 })
    emit('error', { error: new Error('a'), message: 'a' })
    emit('error', { error: new Error('b'), message: 'b' })
    emit('error', { error: new Error('c'), message: 'c' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uninstall removes the listeners and stops reporting', () => {
    const off = installClientErrorReporter()
    uninstall = off
    off()
    expect(handlers['error']).toHaveLength(0)
    expect(handlers['unhandledrejection']).toHaveLength(0)
  })

  it('never throws even when fetch itself throws', () => {
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() => {
      throw new Error('network down')
    })
    uninstall = installClientErrorReporter()
    expect(() => emit('error', { error: new Error('x'), message: 'x' })).not.toThrow()
  })

  it('never throws when the rejection reason has a throwing toString', () => {
    uninstall = installClientErrorReporter()
    const hostile = {
      toString() {
        throw new Error('evil toString')
      },
      [Symbol.toPrimitive]() {
        throw new Error('evil toPrimitive')
      },
    }
    expect(() => emit('unhandledrejection', { reason: hostile })).not.toThrow()
  })

  it('never throws when the error object has a throwing message getter', () => {
    uninstall = installClientErrorReporter()
    const evil = {}
    Object.defineProperty(evil, 'message', {
      get() {
        throw new Error('nope')
      },
    })
    expect(() => emit('error', { error: evil, message: 'fallback' })).not.toThrow()
  })

  it('strips query and fragment from the reported url', () => {
    uninstall = installClientErrorReporter()
    emit('error', {
      error: new Error('x'),
      message: 'x',
      filename: 'https://app.test/app.js?token=secret#frag',
    })
    expect(bodyOf(0).url).toBe('https://app.test/app.js')
  })

  it('a duplicate does not consume a send slot against the cap', () => {
    uninstall = installClientErrorReporter({ maxReports: 2 })
    emit('error', { error: new Error('a'), message: 'a' })
    emit('error', { error: new Error('a'), message: 'a' }) // dup — ignored, no slot used
    emit('error', { error: new Error('b'), message: 'b' })
    emit('error', { error: new Error('c'), message: 'c' }) // 3rd distinct — over cap
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodyOf(0)).toMatchObject({ message: 'a' })
    expect(bodyOf(1)).toMatchObject({ message: 'b' })
  })

  it('is a no-op outside a browser', () => {
    delete (globalThis as unknown as { window?: unknown }).window
    const off = installClientErrorReporter()
    expect(typeof off).toBe('function')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('reportClientError', () => {
  it('forwards a manually reported error tagged react', () => {
    reportClientError(new Error('render failed'), { componentStack: '  in <App>' })
    expect(bodyOf(0)).toMatchObject({
      kind: 'react',
      name: 'Error',
      message: 'render failed',
    })
  })
})
