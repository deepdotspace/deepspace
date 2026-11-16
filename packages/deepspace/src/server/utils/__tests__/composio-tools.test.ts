import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callComposio, composioTools } from '../composio-tools'

const env = {
  API_WORKER_URL: 'https://api.example.com',
  DEEPSPACE_APP_ID: 'app_test',
  APP_IDENTITY_TOKEN: 'identity-token',
  APP_OWNER_JWT: 'owner-jwt',
}
const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name)
const execOpts = { toolCallId: 't1', messages: [] } as never

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const oneTool = {
  success: true,
  data: {
    items: [
      {
        slug: 'GMAIL_SEND_EMAIL',
        name: 'Send',
        description: 'Send an email',
        input_parameters: {
          type: 'object',
          properties: { to: { type: 'string' } },
          required: ['to'],
        },
      },
    ],
  },
}

describe('composioTools', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  function mock(handler: (url: string, init: RequestInit) => Response) {
    fetchSpy = vi.fn(async (url: string | Request | URL, init?: RequestInit) =>
      handler(String(url), init ?? {}),
    )
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
  }

  it('requires a caller', async () => {
    await expect(composioTools(env, {} as never)).rejects.toThrow(/authToken .* or asUser/)
  })

  it('sends the app identity on every call, so it reaches connections made in this app', async () => {
    mock(() => jsonResponse(oneTool))
    await composioTools(env, { authToken: 'jwt' })
    const init = fetchSpy.mock.calls[0][1]
    expect(header(init, 'x-app-id')).toBe('app_test')
    expect(header(init, 'x-app-identity-token')).toBe('identity-token')
    expect(header(init, 'x-act-as-user')).toBeNull()
  })

  it('asUser runs as that user, billed to the owner', async () => {
    mock((url) =>
      url.includes('/list-tools') ? jsonResponse(oneTool) : jsonResponse({ success: true, data: {} }),
    )
    const tools = await composioTools(env, { toolkit: 'gmail', asUser: 'alice' })
    await tools.GMAIL_SEND_EMAIL.execute!({ to: 'a@b.com' }, execOpts)
    for (const [, init] of fetchSpy.mock.calls) {
      expect(header(init, 'Authorization')).toBe('Bearer owner-jwt')
      expect(header(init, 'x-act-as-user')).toBe('alice')
      expect(header(init, 'x-app-id')).toBe('app_test')
    }
  })

  it('a blank asUser is refused rather than falling back to the owner', async () => {
    mock(() => jsonResponse(oneTool))
    await expect(composioTools(env, { asUser: '  ' })).rejects.toThrow(/must be a user id/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('asUser without APP_OWNER_JWT fails clearly', async () => {
    await expect(
      composioTools({ ...env, APP_OWNER_JWT: undefined }, { asUser: 'alice' }),
    ).rejects.toThrow(/APP_OWNER_JWT/)
  })

  it('callComposio returns data, and throws on failure', async () => {
    mock(() => jsonResponse({ success: true, data: { messages: [] } }))
    await expect(
      callComposio(env, 'execute-tool', { slug: 'GMAIL_FETCH_EMAILS' }, { asUser: 'alice' }),
    ).resolves.toEqual({ messages: [] })
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://api.example.com/api/integrations/composio/execute-tool',
    )
    mock(() => jsonResponse({ success: false, message: 'Composio API error 401' }, 502))
    await expect(
      callComposio(env, 'execute-tool', { slug: 'X' }, { asUser: 'alice' }),
    ).rejects.toThrow(/execute-tool failed: Composio API error 401/)
  })

  it('callComposio refuses an endpoint that is not a plain identifier', async () => {
    mock(() => jsonResponse({ success: true, data: {} }))
    await expect(
      callComposio(env, '../../users/me', {}, { asUser: 'alice' }),
    ).rejects.toThrow(/plain identifier/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('builds a ToolSet keyed by slug from list-tools, with auth + scope', async () => {
    mock((url) =>
      url.includes('/list-tools') ? jsonResponse(oneTool) : jsonResponse({ success: true, data: {} }),
    )
    const tools = await composioTools(env, { toolkit: 'gmail', limit: 5, authToken: 'jwt-123' })

    expect(Object.keys(tools)).toEqual(['GMAIL_SEND_EMAIL'])
    expect(tools.GMAIL_SEND_EMAIL.description).toBe('Send an email')
    expect(tools.GMAIL_SEND_EMAIL.inputSchema).toBeDefined()

    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe('https://api.example.com/api/integrations/composio/list-tools')
    expect(header(init, 'Authorization')).toBe('Bearer jwt-123')
    expect(JSON.parse(init.body as string)).toMatchObject({ toolkit: 'gmail', limit: 5 })
  })

  it('passes explicit tool slugs as toolSlugs and a search query', async () => {
    mock(() => jsonResponse(oneTool))
    await composioTools(env, { tools: ['A', 'B'], search: 'email', authToken: 'jwt' })
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string)
    expect(body.toolSlugs).toBe('A,B')
    expect(body.search).toBe('email')
  })

  it('execute() calls execute-tool with slug+arguments+Bearer and returns unwrapped data', async () => {
    mock((url) =>
      url.includes('/list-tools')
        ? jsonResponse(oneTool)
        : jsonResponse({ success: true, data: { id: 'msg_1', sent: true } }),
    )
    const tools = await composioTools(env, { toolkit: 'gmail', authToken: 'jwt-xyz' })
    const result = await tools.GMAIL_SEND_EMAIL.execute!({ to: 'a@b.com' }, execOpts)

    expect(result).toEqual({ id: 'msg_1', sent: true })
    const execCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/execute-tool'))!
    expect(String(execCall[0])).toBe('https://api.example.com/api/integrations/composio/execute-tool')
    expect(header(execCall[1], 'Authorization')).toBe('Bearer jwt-xyz')
    expect(JSON.parse(execCall[1].body as string)).toEqual({
      slug: 'GMAIL_SEND_EMAIL',
      arguments: { to: 'a@b.com' },
    })
  })

  it('execute() surfaces requiresConnection as a connect-me message (no throw)', async () => {
    mock((url) =>
      url.includes('/list-tools')
        ? jsonResponse(oneTool)
        : jsonResponse({ success: true, data: { requiresConnection: true, toolkit: 'gmail' } }),
    )
    const tools = await composioTools(env, { toolkit: 'gmail', authToken: 'jwt' })
    const result = (await tools.GMAIL_SEND_EMAIL.execute!({ to: 'x' }, execOpts)) as {
      requiresConnection?: boolean
      toolkit?: string
      message?: string
    }
    expect(result.requiresConnection).toBe(true)
    expect(result.toolkit).toBe('gmail')
    expect(result.message).toMatch(/connect/i)
  })

  it('execute() returns a readable error (no throw) on failure', async () => {
    mock((url) =>
      url.includes('/list-tools')
        ? jsonResponse(oneTool)
        : jsonResponse(
            { success: false, error: 'upstream_provider_error', message: 'Composio API error 404' },
            502,
          ),
    )
    const tools = await composioTools(env, { toolkit: 'gmail', authToken: 'jwt' })
    const result = (await tools.GMAIL_SEND_EMAIL.execute!({ to: 'x' }, execOpts)) as {
      error?: boolean
      message?: string
    }
    expect(result.error).toBe(true)
    expect(result.message).toMatch(/Composio API error 404/)
  })

  it('throws a clear error if list-tools fails', async () => {
    mock(() => jsonResponse({ success: false, message: 'COMPOSIO_API_KEY not configured' }, 500))
    await expect(composioTools(env, { toolkit: 'gmail', authToken: 'jwt' })).rejects.toThrow(
      /failed to list Composio tools/,
    )
  })

  it('caps an over-long slug key but keeps the real slug for execution', async () => {
    const longSlug = 'X'.repeat(70)
    mock((url) =>
      url.includes('/list-tools')
        ? jsonResponse({
            success: true,
            data: { items: [{ slug: longSlug, description: 'd', input_parameters: { type: 'object', properties: {} } }] },
          })
        : jsonResponse({ success: true, data: { ok: true } }),
    )
    const tools = await composioTools(env, { authToken: 'jwt' })
    const key = Object.keys(tools)[0]
    expect(key.length).toBe(64)
    await tools[key].execute!({}, execOpts)
    const execCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/execute-tool'))!
    expect(JSON.parse(execCall[1].body as string).slug).toBe(longSlug)
  })
})
