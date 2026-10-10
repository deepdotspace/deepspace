/**
 * The request appFiles puts on the wire, and how it reads failures. The
 * round trip against the real handler and R2 is in the platform-worker suite
 * (`app-files-client.test.ts`).
 */
import { describe, expect, it, vi } from 'vitest'
import { MAX_UPLOAD_REQUEST_BYTES } from '../../../shared/app-files'
import { AppFileError, appFiles, type AppFilesEnv } from '../app-files'

function harness(response: Response | (() => Response), token: string | null = 'identity-token') {
  const fetch = vi.fn(async (_request: Request) =>
    typeof response === 'function' ? response() : response,
  )
  const env: AppFilesEnv = {
    DEEPSPACE_APP_ID: 'app_01TEST',
    APP_IDENTITY_TOKEN: token ?? undefined,
    PLATFORM_WORKER: {
      fetch: (input: RequestInfo, init?: RequestInit) => fetch(new Request(input, init)),
    } as unknown as Fetcher,
  }
  return { env, fetch }
}

describe('appFiles', () => {
  it('uploads as the app, for the verified user, with a known length', async () => {
    const { env, fetch } = harness(
      Response.json({
        success: true,
        key: 'apps/app_01TEST/users/user-1/cards/c1/shot.png',
        relativeKey: 'cards/c1/shot.png',
      }),
    )
    const stored = await appFiles(env, { scope: 'self', userId: 'user-1' }).upload(
      new Blob(['png'], { type: 'image/png' }),
      { key: 'cards/c1/shot.png', name: 'shot.png' },
    )

    expect(stored).toEqual({
      key: 'apps/app_01TEST/users/user-1/cards/c1/shot.png',
      relativeKey: 'cards/c1/shot.png',
      path: '/api/files/apps/app_01TEST/users/user-1/cards/c1/shot.png?scope=self',
    })
    const request = fetch.mock.calls[0][0]
    const url = new URL(request.url)
    expect(url.pathname).toBe('/internal/files/upload')
    expect(url.searchParams.get('scope')).toBe('self')
    expect(url.searchParams.get('key')).toBe('cards/c1/shot.png')
    expect(request.headers.get('x-app-id')).toBe('app_01TEST')
    expect(request.headers.get('x-app-identity-token')).toBe('identity-token')
    expect(request.headers.get('x-user-id')).toBe('user-1')
    expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/)
    const form = await request.formData()
    const file = form.get('file') as File
    expect(file.name).toBe('shot.png')
    expect(await file.text()).toBe('png')
  })

  it('addresses stored keys path-encoded for download, list and delete', async () => {
    const { env, fetch } = harness(() =>
      Response.json({
        files: [{ key: 'apps/a/logo 1.png', relativeKey: 'logo 1.png', size: 3, uploaded: 't' }],
        truncated: true,
        cursor: 'next',
        existed: true,
      }),
    )
    const files = appFiles(env, { scope: 'app', userId: 'user-1' })

    await files.download('apps/a/logo 1.png')
    const page = await files.list({ prefix: 'logo', limit: 10 })
    expect(await files.delete('apps/a/logo 1.png')).toEqual({ existed: true })

    const [download, list, remove] = fetch.mock.calls.map(([request]) => request)
    expect(download.url).toBe(
      'https://platform-worker/internal/files/apps/a/logo%201.png?scope=app',
    )
    expect(list.url).toBe('https://platform-worker/internal/files?prefix=logo&limit=10&scope=app')
    expect(remove.method).toBe('DELETE')
    expect(page).toEqual({
      files: [
        {
          key: 'apps/a/logo 1.png',
          relativeKey: 'logo 1.png',
          path: '/api/files/apps/a/logo%201.png?scope=app',
          size: 3,
          uploaded: 't',
        },
      ],
      cursor: 'next',
    })
  })

  it('throws the platform’s refusal with its status', async () => {
    const { env } = harness(
      Response.json({ error: 'Access denied: key outside scope' }, { status: 403 }),
    )
    const failure = await appFiles(env, { scope: 'self', userId: 'user-1' })
      .download('apps/a/users/someone-else/x.png')
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AppFileError)
    expect(failure).toMatchObject({ status: 403, message: 'Access denied: key outside scope' })
  })

  it('names the missing identity token instead of sending a request', async () => {
    const { env, fetch } = harness(Response.json({}), null)
    await expect(appFiles(env, { scope: 'self', userId: 'user-1' }).list()).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('deepspace deploy'),
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a file larger than one request before reading it', async () => {
    const { env, fetch } = harness(Response.json({}))
    const big = { size: MAX_UPLOAD_REQUEST_BYTES + 1 } as Blob
    await expect(
      appFiles(env, { scope: 'app', userId: 'user-1' }).upload(big),
    ).rejects.toMatchObject({ status: 413, message: expect.stringContaining('useR2Files') })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('requires a user', () => {
    const { env } = harness(Response.json({}))
    expect(() => appFiles(env, { scope: 'self', userId: '' })).toThrow(AppFileError)
  })
})
