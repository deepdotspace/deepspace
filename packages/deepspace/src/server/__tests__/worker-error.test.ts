import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describe, expect, it, vi } from 'vitest'
import { workerErrorHandler } from '../worker-error'

// The mechanics every consumer (template scaffold, platform workers) relies
// on are pinned HERE, once — the workers only pin their prefix and wiring.
describe('workerErrorHandler', () => {
  const app = new Hono()
  app.get('/http', () => {
    throw new HTTPException(418, { message: 'teapot' })
  })
  app.get('/plain', () => {
    throw new Error('boom-onerror')
  })
  app.onError(workerErrorHandler('test'))

  it('keeps a response-bearing error’s own answer (no log)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.request('https://fake-host/http')
    expect(res.status).toBe(418)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('logs plain errors as one prefixed string with method + path, answers 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.request('https://fake-host/plain')
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('Internal Server Error')
    expect(spy).toHaveBeenCalledTimes(1)
    const logged = spy.mock.calls[0][0] as string
    expect(typeof logged).toBe('string')
    expect(logged.startsWith('[test] GET /plain: Error: boom-onerror')).toBe(true)
    spy.mockRestore()
  })

  it('lets a worker keep its own generic-500 shape via respond', async () => {
    const json = new Hono()
    json.get('/plain', () => {
      throw new Error('boom')
    })
    json.onError(workerErrorHandler('test', (c) => c.json({ error: 'Internal server error' }, 500)))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await json.request('https://fake-host/plain')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error' })
    spy.mockRestore()
  })
})
