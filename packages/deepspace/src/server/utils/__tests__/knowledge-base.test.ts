import { describe, expect, it, vi } from 'vitest'
import {
  folderFilter,
  knowledge,
  KnowledgeError,
  normalizeKnowledgeFolder,
  type KnowledgeEnv,
} from '../knowledge-base'

type CapturedCall = { url: string; init?: RequestInit }

function harness(response?: (call: CapturedCall) => Response | Promise<Response>) {
  const calls: CapturedCall[] = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, init }
    calls.push(call)
    if (response) return response(call)
    if (url.endsWith('/items') && init?.method === 'POST') {
      const form = init.body as FormData
      const file = form.get('file') as File
      const folder = form.get('folder')
      return Response.json({
        items: [
          {
            id: file.name,
            key: `${typeof folder === 'string' ? folder : ''}${file.name}`,
            status: 'queued',
          },
        ],
      })
    }
    if (url.includes('/items') && init?.method !== 'DELETE')
      return Response.json({ items: [], page: 1, perPage: 20, total: 0, totalPages: 0 })
    if (url.endsWith('/search')) return Response.json({ chunks: [] })
    return new Response(null, { status: 204 })
  })
  const env = {
    API_WORKER: { fetch } as unknown as Fetcher,
    DEEPSPACE_APP_ID: 'app_0000000000000000000000TEST',
    APP_IDENTITY_TOKEN: 'signed-app-token',
  } satisfies KnowledgeEnv
  return { calls, client: knowledge(env), fetch }
}

describe('knowledge folder boundaries', () => {
  it('normalizes a relative folder idempotently and builds the recursive range', () => {
    expect(normalizeKnowledgeFolder('clients/acme')).toBe('clients/acme/')
    expect(normalizeKnowledgeFolder('clients/acme/')).toBe('clients/acme/')
    expect(folderFilter('docs')).toEqual({ folder: { $gte: 'docs/', $lt: 'docs0' } })
  })

  it.each(['/docs', 'docs//private', 'docs/../private', 'docs/./private', 'docs\\private'])(
    'rejects an unsafe folder: %s',
    (folder) => expect(() => normalizeKnowledgeFolder(folder)).toThrow(KnowledgeError),
  )

  it('keeps a scoped folder authoritative even for runtime-cast options', async () => {
    const { calls, client } = harness()
    const scoped = client.scoped({ folder: 'clients/acme' })
    await scoped.search('termination', { folder: 'clients/other' } as never)
    await scoped.list({ folder: 'clients/other' } as never)

    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      folder: 'clients/acme/',
      query: 'termination',
    })
    expect(calls[1].url).toContain('folder=clients%2Facme%2F')
    expect(calls[1].url).not.toContain('other')
  })
})

describe('knowledge transport and validation', () => {
  it('uses only managed API routes, sends app identity, and never sends an instance selector', async () => {
    const { calls, client } = harness()
    await client.add(new File(['hello'], 'readme.md'), { folder: 'docs' })
    await client.list({ page: 2, perPage: 10 })
    await client.search('hello', {
      mode: 'semantic',
      queryRewrite: true,
      limit: 4,
      instanceId: 'caller-selected',
      namespace: 'shared',
    } as never)
    await client.remove('item_1')

    expect(calls.map((call) => [new URL(call.url).pathname, call.init?.method ?? 'GET'])).toEqual([
      ['/api/knowledge/items', 'POST'],
      ['/api/knowledge/items', 'GET'],
      ['/api/knowledge/search', 'POST'],
      ['/api/knowledge/items/item_1', 'DELETE'],
    ])
    for (const call of calls) {
      const headers = new Headers(call.init?.headers)
      expect(headers.get('x-app-id')).toBe('app_0000000000000000000000TEST')
      expect(headers.get('x-app-identity-token')).toBe('signed-app-token')
      expect(call.url).not.toMatch(/instance|namespace/)
      expect(String(call.init?.body ?? '')).not.toMatch(/instanceId|instance_name|namespace/)
    }
  })

  it('rejects invalid list/search options and path-shaped filenames before fetching', async () => {
    const { client, fetch } = harness()
    await expect(client.list({ page: 0 })).rejects.toMatchObject({ code: 'invalid_page' })
    await expect(client.list({ perPage: 51 })).rejects.toMatchObject({ code: 'invalid_per_page' })
    await expect(client.search('q', { limit: 0 })).rejects.toMatchObject({ code: 'invalid_limit' })
    await expect(client.search('q', { matchThreshold: 2 })).rejects.toMatchObject({
      code: 'invalid_match_threshold',
    })
    await expect(client.search('q', { mode: 'unknown' } as never)).rejects.toMatchObject({
      code: 'invalid_mode',
    })
    await expect(client.search('q', { queryRewrite: 'yes' } as never)).rejects.toMatchObject({
      code: 'invalid_query_rewrite',
    })
    await expect(client.list({ status: 'unknown' } as never)).rejects.toMatchObject({
      code: 'invalid_status',
    })
    await expect(client.add(new File(['x'], '../escape.txt'))).rejects.toMatchObject({
      code: 'invalid_filename',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('normalizes stable API errors', async () => {
    const { client } = harness(() =>
      Response.json(
        { error: 'Knowledge is not configured', code: 'knowledge_not_configured' },
        { status: 404 },
      ),
    )
    await expect(client.search('hello')).rejects.toMatchObject({
      status: 404,
      code: 'knowledge_not_configured',
      message: 'Knowledge is not configured',
    })
  })
})

describe('large knowledge files', () => {
  it('rejects an oversized binary without sending any request', async () => {
    const { client, fetch } = harness()
    const file = new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'archive.zip', {
      type: 'application/zip',
    })
    await expect(client.add(file)).rejects.toMatchObject({ status: 413, code: 'file_too_large' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('splits oversized UTF-8 text into valid deterministic parts without losing bytes', async () => {
    const uploaded: File[] = []
    const { client } = harness((call) => {
      const form = call.init?.body as FormData
      const file = form.get('file') as File
      uploaded.push(file)
      return Response.json({ items: [{ id: file.name, key: file.name, status: 'queued' }] })
    })
    const prefix = 'a'.repeat(4 * 1024 * 1024 - 1)
    const contents = `${prefix}é\n\nsecond part`
    const result = await client.add(new File([contents], 'notes.md', { type: 'text/markdown' }))

    expect(uploaded.map((file) => file.name)).toEqual(['notes.part-1.md', 'notes.part-2.md'])
    expect(result.items).toHaveLength(2)
    expect((await Promise.all(uploaded.map((file) => file.text()))).join('')).toBe(contents)
    expect(uploaded.every((file) => file.size <= 4 * 1024 * 1024)).toBe(true)
  })

  it('never pulls a newline from beyond the part-size boundary', async () => {
    const uploaded: File[] = []
    const { client } = harness((call) => {
      const form = call.init?.body as FormData
      const file = form.get('file') as File
      uploaded.push(file)
      return Response.json({ items: [{ id: file.name, key: file.name, status: 'queued' }] })
    })
    const contents = `${'a'.repeat(4 * 1024 * 1024)}\n\nrest`

    await client.add(new File([contents], 'boundary.txt', { type: 'text/plain' }))

    expect(uploaded.map((file) => file.size)).toEqual([4 * 1024 * 1024, 6])
    expect((await Promise.all(uploaded.map((file) => file.text()))).join('')).toBe(contents)
  })

  it('reports completed parts when a later split upload fails at the transport', async () => {
    let uploads = 0
    const { client } = harness((call) => {
      const file = (call.init?.body as FormData).get('file') as File
      if (++uploads === 2) throw new TypeError('network unavailable')
      return Response.json({ items: [{ id: file.name, key: file.name, status: 'queued' }] })
    })

    await expect(
      client.add(
        new File([`${'a'.repeat(4 * 1024 * 1024)}b`], 'partial.txt', { type: 'text/plain' }),
      ),
    ).rejects.toMatchObject({
      code: 'knowledge_upload_failed',
      uploadedItems: [{ id: 'partial.part-1.txt' }],
    })
  })
})
