import { afterEach, expect, it, vi } from 'vitest'
import { connectAgentTools, type BrowserModelContext } from '../agent-tools'

type BrowserTool = Parameters<BrowserModelContext['registerTool']>[0]

afterEach(() => vi.unstubAllGlobals())
function browser(legacy = false) {
  const registered = new Map<string, BrowserTool>()
  const context = {
    registerTool: vi.fn(async (tool: BrowserTool, options?: { signal: AbortSignal }) => {
      registered.set(tool.name, tool)
      if (!legacy) options?.signal.addEventListener('abort', () => registered.delete(tool.name))
    }),
    ...(legacy ? { unregisterTool: vi.fn((name: string) => registered.delete(name)) } : {}),
  }
  vi.stubGlobal('document', legacy ? {} : { modelContext: context })
  vi.stubGlobal('navigator', legacy ? { modelContext: context } : {})
  const fetch = vi.fn(async (_url: string, init: RequestInit) =>
    Response.json(
      init.method === 'GET'
        ? {
            ok: true,
            tools: [
              { name: 'note_add', description: 'Add a note', inputSchema: { type: 'object' } },
            ],
          }
        : { ok: true, result: { saved: true } },
    ),
  )
  vi.stubGlobal('fetch', fetch)
  return { registered, context, fetch }
}
it('does nothing in unsupported browsers', async () => {
  vi.stubGlobal('document', {})
  vi.stubGlobal('navigator', {})
  const getToken = vi.fn()
  expect((await connectAgentTools({ getToken })).supported).toBe(false)
  expect(getToken).not.toHaveBeenCalled()
})
it.each([false, true])(
  'registers server definitions and cleans up on sign-out (legacy=%s)',
  async (legacy) => {
    const { registered, fetch } = browser(legacy)
    const controller = new AbortController()
    let token = 'first'
    const onResult = vi.fn()
    await connectAgentTools({ getToken: async () => token, signal: controller.signal, onResult })
    expect(registered.get('note_add')?.description).toBe('Add a note')
    token = 'refreshed'
    const execute = registered.get('note_add')!.execute
    expect(await execute({ text: 'hello' })).toEqual({ saved: true })
    expect(fetch.mock.calls[1][1]).toMatchObject({
      redirect: 'error',
      headers: { Authorization: 'Bearer refreshed' },
      body: '{"input":{"text":"hello"}}',
    })
    expect(onResult).toHaveBeenCalledWith('note_add', { saved: true })
    controller.abort()
    expect(registered.size).toBe(0)
    await expect(execute({ text: 'stale' })).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(2)
  },
)
it('refuses external routes before requesting a credential', async () => {
  browser()
  const getToken = vi.fn()
  await expect(connectAgentTools({ basePath: '//elsewhere.test', getToken })).rejects.toThrow(
    'same-origin',
  )
  expect(getToken).not.toHaveBeenCalled()
})
it('rolls back partial registration without unregistering another component’s tool', async () => {
  const { registered, context, fetch } = browser(true)
  fetch.mockImplementationOnce(async () =>
    Response.json({
      ok: true,
      tools: [
        { name: 'ours', description: 'ours', inputSchema: {} },
        { name: 'theirs', description: 'theirs', inputSchema: {} },
      ],
    }),
  )
  registered.set('theirs', {
    name: 'theirs',
    description: 'Another component’s tool',
    inputSchema: {},
    execute: async () => null,
  })
  context.registerTool.mockImplementation(async (tool) => {
    if (registered.has(tool.name)) throw new Error('Duplicate')
    registered.set(tool.name, tool)
  })
  await expect(connectAgentTools({ getToken: async () => null })).rejects.toThrow('Duplicate')
  expect([...registered.keys()]).toEqual(['theirs'])
})
it('does not register results that arrive after an account change', async () => {
  const { registered, fetch } = browser()
  const controller = new AbortController()
  fetch.mockImplementationOnce(async () => {
    controller.abort()
    return Response.json({ ok: true, tools: [{ name: 'stale', inputSchema: {} }] })
  })
  await expect(
    connectAgentTools({ getToken: async () => 'old', signal: controller.signal }),
  ).rejects.toThrow()
  expect(registered.size).toBe(0)
})
