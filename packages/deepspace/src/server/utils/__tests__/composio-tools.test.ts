import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { composioTools } from '../composio-tools'

const env = { API_WORKER_URL: 'https://api.example.com' }
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

  it('requires authToken', async () => {
    await expect(composioTools(env, {} as never)).rejects.toThrow(/authToken is required/)
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
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-123')
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
    expect((execCall[1].headers as Record<string, string>).Authorization).toBe('Bearer jwt-xyz')
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
