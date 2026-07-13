/**
 * apiFetch error shape: the thrown message is the server's sentence ONLY —
 * the internal REST path (`API /api/… (NNN):`) used to leak onto every
 * collaborators/transfer refusal and read like a stack trace. The path and
 * status live on the error's fields for DEBUG rendering and branching.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { apiFetch, ApiError } from '../lib/api'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubResponse(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })),
  )
}

describe('apiFetch errors', () => {
  it('throws the server sentence only, with path/status/code on fields', async () => {
    stubResponse(429, {
      error: 'Accepting exceeds your deployed-app limit (1/1).',
      code: 'quota_exceeded',
    })
    const err = (await apiFetch('https://x', 'tok', '/api/apps/app_1/transfer/accept').catch(
      (e) => e,
    )) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toBe('Accepting exceeds your deployed-app limit (1/1).')
    expect(err.message).not.toMatch(/API \/api/)
    expect(err.status).toBe(429)
    expect(err.code).toBe('quota_exceeded')
    expect(err.apiPath).toBe('/api/apps/app_1/transfer/accept')
  })

  it('falls back to a generic sentence when the body has no error text', async () => {
    stubResponse(502, '')
    const err = (await apiFetch('https://x', 'tok', '/api/thing').catch((e) => e)) as ApiError
    expect(err.message).toBe('Request failed (502)')
  })
})
