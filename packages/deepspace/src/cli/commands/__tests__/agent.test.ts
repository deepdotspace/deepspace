import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import agent, {
  parseAgentTimeout,
  resolveAgentInput,
  resolveAgentTarget,
  runAgentInvoke,
  runAgentTools,
} from '../agent'
import * as auth from '../../auth'
import { AGENT_TOOL_REQUEST_BODY_CAP } from '../../../shared/agent-tool-protocol'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  process.exitCode = undefined
})

const tool = {
  name: 'search',
  description: 'Search the project',
  inputSchema: { type: 'object', required: ['query'] },
  outputSchema: { type: 'object', required: ['answer'] },
}
const app = { id: 'app_01', name: 'Example' }

function mockToken(token = 'jwt-secret') {
  vi.spyOn(auth, 'mintAgentToken').mockResolvedValue(token)
}

describe('agent command surface and target allowlist', () => {
  it('exposes only tools and invoke leaves, each with injected --json', () => {
    expect(Object.keys(agent.subCommands ?? {})).toEqual(['tools', 'invoke'])
    const commands = agent.subCommands as Record<string, { args: Record<string, unknown> }>
    expect(commands.tools.args).toHaveProperty('app')
    expect(commands.tools.args).toHaveProperty('json')
    expect(commands.invoke.args).toMatchObject({
      input: expect.anything(),
      'input-file': expect.anything(),
    })
    expect(commands.invoke.args).toHaveProperty('timeout')
  })

  it('maps labels to the selected plane and allows root loopback URLs', () => {
    expect(resolveAgentTarget('my-app', 'production')).toEqual({ url: 'https://my-app.app.space' })
    expect(resolveAgentTarget('my-app', 'staging')).toEqual({
      url: 'https://my-app.spacestest.com',
    })
    expect(resolveAgentTarget('http://localhost:8787')).toEqual({ url: 'http://localhost:8787' })
    expect(resolveAgentTarget('https://[::1]:8787')).toEqual({ url: 'https://[::1]:8787' })
    expect(resolveAgentTarget('https://admin.deep.space', 'production')).toEqual({
      url: 'https://admin.deep.space',
    })
    expect(resolveAgentTarget('https://admin.deepspacesites.com', 'staging')).toEqual({
      url: 'https://admin.deepspacesites.com',
    })
  })

  it.each([
    'https://my-app.spacestest.com',
    'https://my-app.example.com',
    'http://my-app.app.space',
    'https://custom.example.com',
    'https://my-app.app.space/not-root',
    'https://user:pass@my-app.app.space',
    'https://my-app.app.space?x=1',
    'https://a.b.app.space',
    'https://dashboard.deep.space',
    'a',
    'app--name',
    'https://app--name.app.space',
  ])('rejects unsafe or wrong-plane public target %s', (value) => {
    expect(() => resolveAgentTarget(value, 'production')).toThrow(/canonical|root|exactly/i)
  })

  it('refuses the bare localhost label instead of targeting localhost.app.space', () => {
    expect(() => resolveAgentTarget('localhost', 'production')).toThrow(/loopback URL/)
    expect(() => resolveAgentTarget('Localhost', 'staging')).toThrow(/loopback URL/)
  })

  it('does not cross planes between the production and staging admin origins', () => {
    expect(() => resolveAgentTarget('https://admin.deep.space', 'staging')).toThrow(
      /canonical|root|exactly/i,
    )
    expect(() => resolveAgentTarget('https://admin.deepspacesites.com', 'production')).toThrow(
      /canonical|root|exactly/i,
    )
    expect(() => resolveAgentTarget('https://dashboard.deepspacesites.com', 'staging')).toThrow(
      /canonical|root|exactly/i,
    )
  })

  it('rejects a bad target before it obtains a token', async () => {
    const token = vi.spyOn(auth, 'mintAgentToken').mockResolvedValue('jwt-secret')
    await expect(
      runAgentTools({ app: 'https://attacker.example', json: true }),
    ).rejects.toMatchObject({
      code: 'invalid_agent_app',
    })
    expect(token).not.toHaveBeenCalled()
  })
})

describe('agent input and timeout validation', () => {
  it('defaults JSON input and rejects conflicts, invalid JSON, size, and invalid timeout locally', async () => {
    await expect(resolveAgentInput({})).resolves.toEqual({})
    await expect(resolveAgentInput({ input: '{}', inputFile: 'x.json' })).rejects.toMatchObject({
      code: 'conflicting_input_args',
    })
    await expect(resolveAgentInput({ input: '{' })).rejects.toMatchObject({
      code: 'invalid_input_json',
    })
    await expect(
      resolveAgentInput({ input: 'x'.repeat(AGENT_TOOL_REQUEST_BODY_CAP + 1) }),
    ).rejects.toMatchObject({
      code: 'input_too_large',
    })
    expect(parseAgentTimeout(undefined)).toBe(120_000)
    expect(() => parseAgentTimeout('1.2')).toThrow(/positive integer/)
    expect(() => parseAgentTimeout('600001')).toThrow(/positive integer/)
  })

  it('reads bounded JSON from a file and stdin', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'deepspace-agent-'))
    const file = join(directory, 'input.json')
    writeFileSync(file, '{"from":"file"}')
    try {
      await expect(resolveAgentInput({ inputFile: file })).resolves.toEqual({ from: 'file' })
      const iterator = vi
        .spyOn(process.stdin, Symbol.asyncIterator)
        .mockImplementation(async function* (): AsyncGenerator<Buffer, undefined, unknown> {
          yield Buffer.from('{"from":"stdin"}')
          return undefined
        })
      await expect(resolveAgentInput({ inputFile: '-' })).resolves.toEqual({ from: 'stdin' })
      iterator.mockRestore()
      writeFileSync(file, 'x'.repeat(AGENT_TOOL_REQUEST_BODY_CAP + 1))
      await expect(resolveAgentInput({ inputFile: file })).rejects.toMatchObject({
        code: 'input_too_large',
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects a serialized invocation envelope over the Worker limit before authentication', async () => {
    const token = vi.spyOn(auth, 'mintAgentToken').mockResolvedValue('jwt-secret')
    const raw = JSON.stringify('x'.repeat(AGENT_TOOL_REQUEST_BODY_CAP - 2))

    await expect(
      runAgentInvoke({ app: 'example', tool: 'search', input: raw, json: true }),
    ).rejects.toMatchObject({ code: 'input_too_large' })
    expect(token).not.toHaveBeenCalled()
  })
})

describe('agent requests and output', () => {
  it('lists tools with safe manual redirects and matching human / machine data', async () => {
    mockToken()
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Response.json({ ok: true, app, tools: [tool] }))
    vi.stubGlobal('fetch', fetchMock)
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation(((line: unknown) =>
      lines.push(String(line))) as never)

    const human = await runAgentTools({ app: 'example', json: false })
    const machine = await runAgentTools({ app: 'example', json: true })
    expect(human.data).toEqual(machine.data)
    expect(lines.join('\n')).toContain('Example (app_01, https://example.app.space)')
    expect(lines.join('\n')).toContain('search: Search the project')
    expect(lines.join('\n')).toContain('"query"')
    expect(lines.join('\n')).toContain('Output:')
    expect(lines.join('\n')).toContain('"answer"')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).authorization).toBe(
      'Bearer jwt-secret',
    )
  })

  it('posts parsed input and returns matching human / machine invoke data', async () => {
    mockToken()
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Response.json({ ok: true, result: { answer: 42 } }))
    vi.stubGlobal('fetch', fetchMock)
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation(((line: unknown) =>
      lines.push(String(line))) as never)
    const human = await runAgentInvoke({
      app: 'example',
      tool: 'a/b',
      input: '{"q":"ok"}',
      json: false,
    })
    const machine = await runAgentInvoke({
      app: 'example',
      tool: 'a/b',
      input: '{"q":"ok"}',
      json: true,
    })
    expect(human.data).toEqual(machine.data)
    expect(lines.join('\n')).toContain('App: example (https://example.app.space)')
    expect(lines.join('\n')).toContain('Tool: a/b')
    expect(lines.join('\n')).toContain('Result:')
    expect(lines.join('\n')).toContain('"answer": 42')
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://example.app.space/_deepspace/agent/tools/a%2Fb',
    )
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ input: { q: 'ok' } })
  })

  it('does not follow redirects or leak the token in refusal output', async () => {
    mockToken('jwt-secret')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('', { status: 302, headers: { location: 'https://elsewhere' } }),
        ),
    )
    await expect(runAgentTools({ app: 'example', json: true })).rejects.toMatchObject({
      code: 'agent_redirect_refused',
    })
    try {
      await runAgentTools({ app: 'example', json: true })
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('jwt-secret')
      expect(error).not.toHaveProperty('message', expect.stringContaining('jwt-secret'))
    }
  })

  it('redacts a bearer token echoed by an app error', async () => {
    mockToken('jwt-secret')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ code: 'app_denied', error: 'Bearer jwt-secret was rejected' }),
          {
            status: 403,
          },
        ),
      ),
    )
    try {
      await runAgentTools({ app: 'example', json: true })
    } catch (error) {
      expect(error).toMatchObject({ code: 'app_denied' })
      expect((error as Error).message).not.toContain('jwt-secret')
    }
  })

  it('redacts a bearer token echoed anywhere in a successful app result', async () => {
    mockToken('jwt-secret')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          ok: true,
          result: { 'jwt-secret': ['Bearer jwt-secret'] },
        }),
      ),
    )

    const result = await runAgentInvoke({
      app: 'example',
      tool: 'search',
      json: true,
    })

    expect(JSON.stringify(result)).not.toContain('jwt-secret')
  })

  it('remints exactly once after a 401 without falling back to the ordinary token', async () => {
    const mint = vi
      .spyOn(auth, 'mintAgentToken')
      .mockResolvedValueOnce('old-secret')
      .mockResolvedValueOnce('new-secret')
    const ordinary = vi.spyOn(auth, 'ensureToken')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ ok: true, app, tools: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await runAgentTools({ app: 'example', json: true })
    expect(mint).toHaveBeenCalledTimes(2)
    expect(mint).toHaveBeenNthCalledWith(1, 'https://example.app.space')
    expect(mint).toHaveBeenNthCalledWith(2, 'https://example.app.space')
    expect(ordinary).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).authorization).toBe(
      'Bearer old-secret',
    )
    expect((fetchMock.mock.calls[1][1].headers as Record<string, string>).authorization).toBe(
      'Bearer new-secret',
    )
  })

  it.each([
    [
      '403/server error',
      new Response(JSON.stringify({ code: 'app_denied', error: 'No access' }), { status: 403 }),
      'app_denied',
    ],
    ['plain 404', new Response('missing', { status: 404 }), 'agent_endpoint_not_found'],
    ['invalid response', Response.json({ ok: true, tools: [] }), 'invalid_agent_response'],
  ])('returns a stable refusal for %s', async (_label, response, code) => {
    mockToken()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    await expect(runAgentTools({ app: 'example', json: true })).rejects.toMatchObject({ code })
  })

  it('maps timeout and network failures to stable refusals', async () => {
    mockToken()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            pull() {
              throw new DOMException('aborted', 'AbortError')
            },
          }),
        ),
      ),
    )
    await expect(
      runAgentInvoke({ app: 'example', tool: 'x', timeout: '1', json: true }),
    ).rejects.toMatchObject({
      code: 'agent_timeout',
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(runAgentTools({ app: 'example', json: true })).rejects.toMatchObject({
      code: 'agent_network_error',
    })
  })
})
