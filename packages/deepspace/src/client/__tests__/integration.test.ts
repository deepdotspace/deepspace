import { afterEach, describe, expect, it, vi } from 'vitest'

import { getAuthToken } from '../auth/token'
import { integration } from '../integration'

vi.mock('../auth/token', () => ({ getAuthToken: vi.fn() }))

const mockedToken = vi.mocked(getAuthToken)

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('integration client routing', () => {
  it('rejects every endpoint that could escape the same-origin integration proxy', async () => {
    mockedToken.mockResolvedValue('secret-token')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    for (const endpoint of [
      'https://other.example/collect',
      'http://other.example/collect',
      '//other.example/collect',
      '/other-path',
      '../other-path',
      'openai/../other-path',
    ]) {
      await expect(integration.get(endpoint)).rejects.toThrow(/relative route segments/)
    }

    expect(mockedToken).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('routes valid endpoints through the current origin proxy with auth', async () => {
    mockedToken.mockResolvedValue('secret-token')
    vi.stubGlobal('window', { location: { origin: 'https://sample.app.space' } })
    const fetchSpy = vi.fn(async () => Response.json({ success: true, data: { answer: 42 } }))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(
      integration.get<{ answer: number }>('openai/models', { limit: 2 }),
    ).resolves.toEqual({ success: true, data: { answer: 42 } })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://sample.app.space/api/integrations/openai/models?limit=2',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }),
      }),
    )
  })

  it('reports caller cancellation without fetching or minting a token', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(
      integration.get('openai/models', undefined, { signal: controller.signal }),
    ).resolves.toEqual({ success: false, error: 'Request cancelled' })
    expect(mockedToken).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
