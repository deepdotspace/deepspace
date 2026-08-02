import { describe, expect, it, vi } from 'vitest'
import { captureScreenshot, type ScreenshotEnv } from '../screenshot'

const TARGET_WITH_SECRET = 'https://preview.app.space/dashboard?token=do-not-echo'

function screenshotEnv(response: Response): {
  env: ScreenshotEnv
  fetch: ReturnType<typeof vi.fn>
} {
  const fetch = vi.fn(async (_request: Request) => response)
  return {
    env: {
      APP_IDENTITY_TOKEN: 'identity-token',
      DEEPSPACE_APP_ID: 'app_01TEST',
      PLATFORM_WORKER: { fetch } as unknown as Fetcher,
    },
    fetch,
  }
}

describe('captureScreenshot', () => {
  it('sends only the URL and returns PNG bytes', async () => {
    const { env, fetch } = screenshotEnv(
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png' },
      }),
    )

    const result = await captureScreenshot(env, TARGET_WITH_SECRET)

    if (!result) throw new Error('expected screenshot result')
    expect(result?.contentType).toBe('image/png')
    expect([...new Uint8Array(result.body)]).toEqual([137, 80, 78, 71])
    expect(fetch).toHaveBeenCalledOnce()
    const request = fetch.mock.calls[0][0]
    expect(request.url).toBe('https://platform-worker/internal/screenshot')
    expect(request.method).toBe('POST')
    expect(request.headers.get('x-app-id')).toBe('app_01TEST')
    expect(request.headers.get('x-app-identity-token')).toBe('identity-token')
    expect(await request.json()).toEqual({ url: TARGET_WITH_SECRET })
  })

  it('does not copy a platform error body into agent-visible logs', async () => {
    const { env } = screenshotEnv(
      Response.json(
        { error: 'Capture failed', detail: `Navigation failed at ${TARGET_WITH_SECRET}` },
        { status: 502 },
      ),
    )
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await captureScreenshot(env, TARGET_WITH_SECRET)
    const logged = warning.mock.calls.flat().join(' ')
    warning.mockRestore()

    expect(result).toBeNull()
    expect(logged).toBe('[captureScreenshot] platform returned 502')
    expect(logged).not.toContain(TARGET_WITH_SECRET)
    expect(logged).not.toContain('do-not-echo')
  })
})
