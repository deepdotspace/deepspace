import { jsonSchema, tool, type ToolSet } from 'ai'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import {
  AGENT_TOOL_REQUEST_BODY_CAP,
  AGENT_TOOL_RESPONSE_BODY_CAP,
  registerAgentToolRoutes,
  type AgentToolContext,
  type AgentToolAccessResult,
  type AgentToolRouteEnv,
} from '../agent-tools'
import { DEFAULT_CONTEXT_CONFIG } from '../utils/chat-context'

const access: AgentToolAccessResult = {
  ok: true,
  auth: { userId: 'user_123', claims: { sub: 'user_123' } },
}

interface RecordedDoRequest {
  body: unknown
  headers: Headers
  signal: AbortSignal
}

function makeEnv(
  onFetch: (request: Request) => Promise<Response> = async () => Response.json({ ok: true }),
) {
  const names: string[] = []
  const requests: RecordedDoRequest[] = []
  const env = {
    APP_NAME: 'Tool Test',
    DEEPSPACE_APP_ID: 'app_01H',
    RECORD_ROOMS: {
      idFromName(name: string) {
        names.push(name)
        return name
      },
      get() {
        return {
          async fetch(request: Request) {
            requests.push({
              body: await request.clone().json(),
              headers: request.headers,
              signal: request.signal,
            })
            return onFetch(request)
          },
        }
      },
    } as unknown as DurableObjectNamespace,
  } satisfies AgentToolRouteEnv
  return { env, names, requests }
}

function makeApp(
  env: AgentToolRouteEnv,
  options: {
    resolveAccess?: (request: Request) => Promise<AgentToolAccessResult>
    buildTools?: (
      executor: (name: string, params: Record<string, unknown>) => Promise<unknown>,
      context: AgentToolContext<AgentToolRouteEnv>,
    ) => ToolSet
  } = {},
) {
  const app = new Hono<{ Bindings: AgentToolRouteEnv }>()
  registerAgentToolRoutes(app, {
    resolveAccess: options.resolveAccess ?? (async () => access),
    buildTools:
      options.buildTools ??
      (() => ({
        echo: tool({
          description: 'Echo an input.',
          inputSchema: z.object({ message: z.string() }),
          execute: async ({ message }) => ({ message }),
        }),
      })),
  })
  return app
}

async function json(response: Response): Promise<unknown> {
  return response.json()
}

describe('agent tool routes', () => {
  it('checks access before discovery or constructing tools', async () => {
    const { env, names } = makeEnv()
    const buildTools = vi.fn()
    const app = makeApp(env, {
      resolveAccess: async () => ({ ok: false, status: 401 }),
      buildTools,
    })

    const response = await app.request('https://app.test/_deepspace/agent/tools', undefined, env)

    expect(response.status).toBe(401)
    expect(await json(response)).toEqual({
      ok: false,
      code: 'unauthenticated',
      error: 'Authentication is required.',
    })
    expect(buildTools).not.toHaveBeenCalled()
    expect(names).toEqual([])
  })

  it('preserves forbidden access distinctly from unauthenticated access', async () => {
    const { env } = makeEnv()
    const app = makeApp(env, { resolveAccess: async () => ({ ok: false, status: 403 }) })

    const response = await app.request('https://app.test/_deepspace/agent/tools', undefined, env)

    expect(response.status).toBe(403)
    expect(((await json(response)) as { code: string }).code).toBe('forbidden')
  })

  it('passes through a retryable 503 when the access check could not complete', async () => {
    const { env } = makeEnv()
    const app = makeApp(env, { resolveAccess: async () => ({ ok: false, status: 503 }) })

    const response = await app.request('https://app.test/_deepspace/agent/tools', undefined, env)

    expect(response.status).toBe(503)
    expect(((await json(response)) as { code: string }).code).toBe('access_check_unavailable')
  })

  it('reports a side-effect-only tool (undefined result) as ok with a null result', async () => {
    const { env } = makeEnv()
    const app = makeApp(env, {
      buildTools: () => ({
        notify: tool({ inputSchema: z.object({}), execute: async () => undefined }),
      }),
    })

    const response = await app.request(
      'https://app.test/_deepspace/agent/tools/notify',
      { method: 'POST', body: JSON.stringify({ input: {} }) },
      env,
    )

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ ok: true, result: null })
  })

  it('discovers only executable tools with sorted schemas', async () => {
    const { env } = makeEnv()
    const app = makeApp(env, {
      buildTools: () => ({
        zeta: tool({
          description: 'Zeta.',
          inputSchema: z.object({ count: z.number() }),
          execute: async () => ({ count: 1 }),
        }),
        alpha: tool({
          description: 'Alpha.',
          inputSchema: z.object({}),
          outputSchema: z.object({ value: z.string() }),
          execute: async () => ({ value: 'ok' }),
        }),
        clientOnly: tool({
          description: 'Not server executable.',
          inputSchema: z.object({}),
          outputSchema: z.string(),
        }),
      }),
    })

    const response = await app.request('https://app.test/_deepspace/agent/tools', undefined, env)
    const body = (await json(response)) as {
      ok: boolean
      app: { id: string; name: string }
      tools: Array<{ name: string; inputSchema: unknown; outputSchema?: unknown }>
    }

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toMatchObject({ ok: true, app: { id: 'app_01H', name: 'Tool Test' } })
    expect(body.tools.map((item) => item.name)).toEqual(['alpha', 'zeta'])
    expect(body.tools[0].inputSchema).toMatchObject({ type: 'object' })
    expect(body.tools[0].outputSchema).toMatchObject({ type: 'object' })
  })

  it('refuses an oversized discovery document with a bounded stable error', async () => {
    const { env } = makeEnv()
    const app = makeApp(env, {
      buildTools: () => ({
        oversized: tool({
          description: 'x'.repeat(AGENT_TOOL_RESPONSE_BODY_CAP),
          inputSchema: z.object({}),
          execute: async () => null,
        }),
      }),
    })

    const response = await app.request('https://app.test/_deepspace/agent/tools', undefined, env)

    expect(response.status).toBe(500)
    expect(await json(response)).toEqual({
      ok: false,
      code: 'tool_configuration_error',
      error: 'Assistant tools are not configured correctly.',
    })
  })

  it('validates input before executing the tool', async () => {
    const { env, requests } = makeEnv()
    const execute = vi.fn(async () => ({ ok: true }))
    const app = makeApp(env, {
      buildTools: () => ({
        echo: tool({
          inputSchema: z.object({ message: z.string() }),
          execute,
        }),
      }),
    })

    const response = await app.request(
      'https://app.test/_deepspace/agent/tools/echo',
      { method: 'POST', body: JSON.stringify({ input: { message: 12 } }) },
      env,
    )

    expect(response.status).toBe(400)
    const body = (await json(response)) as { code: string; error: string }
    expect(body.code).toBe('invalid_tool_input')
    // The stated cause: exit-1 callers are told to fix it, so the refusal
    // must name it (2026-08-28 agent-tools AX F1).
    expect(body.error.length).toBeGreaterThan('The tool input is invalid.'.length)
    expect(execute).not.toHaveBeenCalled()
    expect(requests).toEqual([])
  })

  it('keeps an unusual validator exception inside the input-refusal boundary', async () => {
    const { env } = makeEnv()
    const execute = vi.fn()
    const app = makeApp(env, {
      buildTools: () => ({
        echo: tool({
          inputSchema: jsonSchema(
            { type: 'object' },
            {
              validate: () => {
                throw null
              },
            },
          ),
          execute,
        }),
      }),
    })
    const response = await app.request(
      'https://app.test/_deepspace/agent/tools/echo',
      {
        method: 'POST',
        body: '{"input":{}}',
      },
      env,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'invalid_tool_input' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('enforces the published additionalProperties: an unknown top-level key refuses, named', async () => {
    // Zod's runtime default STRIPS unknown keys, so without the route-level
    // check a typo'd argument validated and reported success under the
    // defaults (2026-08-28 agent-tools AX F2: {"limitt":99} succeeded).
    const { env } = makeEnv()
    const execute = vi.fn(async () => ({ ok: true }))
    const app = makeApp(env, {
      buildTools: () => ({
        echo: tool({
          inputSchema: z.object({ message: z.string().optional() }),
          execute,
        }),
      }),
    })

    const response = await app.request(
      'https://app.test/_deepspace/agent/tools/echo',
      { method: 'POST', body: JSON.stringify({ input: { messagee: 'typo' } }) },
      env,
    )

    expect(response.status).toBe(400)
    const body = (await json(response)) as { code: string; error: string }
    expect(body.code).toBe('invalid_tool_input')
    expect(body.error).toContain('messagee')
    expect(execute).not.toHaveBeenCalled()
  })

  it('a deliberately OPEN schema (catchall) keeps its extra keys — runtime truth, not the converted jsonSchema', async () => {
    // The AI SDK's zod conversion emits additionalProperties: false even for
    // .passthrough()/.catchall() objects, so enforcing the CONVERTED schema
    // would 400 legitimate dynamic-field tools (caught in review). The check
    // keys on what the validator DROPPED instead: open schemas drop nothing.
    const { env } = makeEnv()
    const execute = vi.fn(async () => ({ ok: true }))
    const app = makeApp(env, {
      buildTools: () => ({
        record: tool({
          inputSchema: z.object({ table: z.string() }).catchall(z.unknown()),
          execute,
        }),
      }),
    })

    const response = await app.request(
      'https://app.test/_deepspace/agent/tools/record',
      { method: 'POST', body: JSON.stringify({ input: { table: 't', extra: 1 } }) },
      env,
    )

    expect(response.status).toBe(200)
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ table: 't', extra: 1 }),
      expect.anything(),
    )
  })

  it('tool_not_found lists the available tools', async () => {
    // Absorbs typos and the dotted-vs-underscored separator confusion
    // (2026-08-28 agent-tools AX F5) without a second discovery call.
    const { env } = makeEnv()
    const app = makeApp(env, {
      buildTools: () => ({
        records_create: tool({ inputSchema: z.object({}), execute: async () => null }),
        records_query: tool({ inputSchema: z.object({}), execute: async () => null }),
      }),
    })

    const response = await app.request(
      'https://app.test/_deepspace/agent/tools/records.create',
      { method: 'POST', body: JSON.stringify({ input: {} }) },
      env,
    )

    expect(response.status).toBe(404)
    const body = (await json(response)) as { code: string; error: string }
    expect(body.code).toBe('tool_not_found')
    expect(body.error).toContain('records_create')
    expect(body.error).toContain('records_query')
  })

  it('reports an unknown tool before reading its request body', async () => {
    const { env } = makeEnv()
    const app = makeApp(env, {
      buildTools: () => ({
        records_create: tool({ inputSchema: z.object({}), execute: async () => null }),
      }),
    })

    const response = await app.request(
      'https://app.test/_deepspace/agent/tools/records.create',
      { method: 'POST', body: 'not json' },
      env,
    )

    expect(response.status).toBe(404)
    const body = (await json(response)) as { code: string; error: string }
    expect(body.code).toBe('tool_not_found')
    expect(body.error).toContain('records_create')
  })

  it('uses the canonical app room as the caller without app-action bypasses', async () => {
    const { env, names, requests } = makeEnv(async () =>
      Response.json({ success: true, data: { id: 'r1' } }),
    )
    const app = makeApp(env, {
      buildTools: (executor) => ({
        records: tool({
          inputSchema: z.object({ collection: z.string() }),
          execute: (input) => executor('records.query', input),
        }),
      }),
    })

    const response = await app.request(
      'https://app.test/_deepspace/agent/tools/records',
      { method: 'POST', body: JSON.stringify({ input: { collection: 'notes' } }) },
      env,
    )

    expect(response.status).toBe(200)
    expect(names).toEqual(['app:app_01H'])
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toEqual({ tool: 'records.query', params: { collection: 'notes' } })
    expect(requests[0].headers.get('x-user-id')).toBe('user_123')
    expect(requests[0].headers.has('x-app-action')).toBe(false)
  })

  it('gives buildTools the request context and whole record results', async () => {
    // One page well past the model's tool-result budget.
    const records = Array.from({ length: 400 }, (_, index) => ({
      recordId: `r${index}`,
      data: { note: 'x'.repeat(200) },
    }))
    const { env, requests } = makeEnv(async () =>
      Response.json({ success: true, data: { records, count: records.length } }),
    )
    let seen: AgentToolContext<AgentToolRouteEnv> | undefined
    const app = makeApp(env, {
      buildTools: (executor, context) => {
        seen = context
        return {
          count: tool({
            inputSchema: z.object({}),
            execute: async () => {
              const page = (await executor('records.query', { collection: 'notes' })) as {
                data: { records: unknown[]; truncated?: boolean }
              }
              return { read: page.data.records.length, truncated: page.data.truncated === true }
            },
          }),
        }
      },
    })

    const response = await app.request(
      'https://app.test/_deepspace/agent/tools/count',
      { method: 'POST', body: JSON.stringify({ input: {} }) },
      env,
    )

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ ok: true, result: { read: 400, truncated: false } })
    expect(seen?.env).toBe(env)
    expect(seen?.userId).toBe('user_123')
    expect(seen?.request.url).toBe('https://app.test/_deepspace/agent/tools/count')
    expect(requests.map((request) => request.headers.get('x-user-id'))).toEqual(['user_123'])
  })

  it('trims an oversized page for the agent and says where the next page starts', async () => {
    const records = Array.from({ length: 400 }, (_, index) => ({
      recordId: `r${index}`,
      data: { note: 'x'.repeat(200) },
    }))
    const { env } = makeEnv(async () =>
      Response.json({ success: true, data: { records, count: 400, offset: 100, nextOffset: 500 } }),
    )
    const app = makeApp(env, {
      buildTools: (executor) => ({
        records_query: tool({
          inputSchema: z.object({ collection: z.string() }),
          execute: (input) => executor('records.query', input),
        }),
      }),
    })

    const response = await app.request(
      'https://app.test/_deepspace/agent/tools/records_query',
      { method: 'POST', body: JSON.stringify({ input: { collection: 'notes' } }) },
      env,
    )

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(
      DEFAULT_CONTEXT_CONFIG.toolResultCap + 100,
    )
    const { result } = JSON.parse(text) as {
      result: {
        data: {
          records: unknown[]
          count: number
          nextOffset: number
          truncated: boolean
          returned: number
          total: number
        }
      }
    }
    const kept = result.data.records.length
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(400)
    expect(result.data).toMatchObject({
      truncated: true,
      returned: kept,
      total: 400,
      count: kept,
      nextOffset: 100 + kept,
    })
  })

  it('runs tools in the room the access grant names', async () => {
    const { env, names } = makeEnv(async () => Response.json({ success: true, data: {} }))
    const app = makeApp(env, {
      resolveAccess: async () => ({ ...access, room: 'notes:user_123' }),
      buildTools: (executor) => ({
        records: tool({
          inputSchema: z.object({}),
          execute: () => executor('user.current', {}),
        }),
      }),
    })

    const response = await app.request(
      'https://app.test/_deepspace/agent/tools/records',
      { method: 'POST', body: JSON.stringify({ input: {} }) },
      env,
    )

    expect(response.status).toBe(200)
    expect(names).toEqual(['notes:user_123'])
  })

  it('names the size and the limit when a result is too large', async () => {
    const { env } = makeEnv()
    const app = makeApp(env, {
      buildTools: () => ({
        big: tool({
          inputSchema: z.object({}),
          execute: async () => ({ data: 'x'.repeat(DEFAULT_CONTEXT_CONFIG.toolResultCap) }),
        }),
      }),
    })
    const response = await app.request(
      'https://app.test/_deepspace/agent/tools/big',
      { method: 'POST', body: JSON.stringify({ input: {} }) },
      env,
    )
    const body = (await json(response)) as { code: string; error: string }
    expect(response.status).toBe(500)
    expect(body.code).toBe('tool_result_too_large')
    expect(body.error).toContain(`It was ${DEFAULT_CONTEXT_CONFIG.toolResultCap + 11} bytes`)
    expect(body.error).toContain(`at most ${DEFAULT_CONTEXT_CONFIG.toolResultCap}`)
  })

  it('forwards the route abort signal into a DO tool request', async () => {
    let releaseFetch: (() => void) | undefined
    const fetchReleased = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    const { env, requests } = makeEnv(async () => {
      await fetchReleased
      return Response.json({ success: true })
    })
    const app = makeApp(env, {
      buildTools: (executor) => ({
        records: tool({
          inputSchema: z.object({}),
          execute: (input) => executor('schema.list', input),
        }),
      }),
    })
    const controller = new AbortController()
    const responsePromise = app.fetch(
      new Request('https://app.test/_deepspace/agent/tools/records', {
        method: 'POST',
        body: JSON.stringify({ input: {} }),
        signal: controller.signal,
      }),
      env,
    )
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    controller.abort()
    releaseFetch?.()

    await responsePromise
    expect(requests[0].signal.aborted).toBe(true)
  })

  it('does not expose missing or non-executable tools', async () => {
    const { env } = makeEnv()
    const app = makeApp(env, {
      buildTools: () => ({
        clientOnly: tool({ inputSchema: z.object({}), outputSchema: z.string() }),
      }),
    })

    for (const name of ['missing', 'clientOnly']) {
      const response = await app.request(
        `https://app.test/_deepspace/agent/tools/${name}`,
        { method: 'POST', body: JSON.stringify({ input: {} }) },
        env,
      )
      expect(response.status).toBe(404)
      expect(((await json(response)) as { code: string }).code).toBe('tool_not_found')
    }
  })

  it('owns unsupported agent paths instead of falling through to a broad platform proxy', async () => {
    const { env } = makeEnv()
    const app = makeApp(env)
    app.all('/_deepspace/*', () => new Response('platform proxy'))

    const response = await app.request(
      'https://app.test/_deepspace/agent/tools/echo',
      { method: 'DELETE' },
      env,
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await json(response)).toMatchObject({ ok: false, code: 'tool_not_found' })
  })

  it('normalizes execution and result failures without leaking tool details', async () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const asyncOutput = {
      async *[Symbol.asyncIterator]() {
        yield 'streamed'
      },
    }
    const cases: Array<[string, () => unknown, string]> = [
      [
        'thrown',
        () => {
          throw new Error('private detail')
        },
        'tool_execution_failed',
      ],
      ['streaming', () => asyncOutput, 'invalid_tool_result'],
      ['cyclic', () => cyclic, 'invalid_tool_result'],
      [
        'oversized',
        () => ({ data: 'x'.repeat(DEFAULT_CONTEXT_CONFIG.toolResultCap + 1) }),
        'tool_result_too_large',
      ],
      [
        'utf8 oversized',
        () => ({ data: '🍃'.repeat(DEFAULT_CONTEXT_CONFIG.toolResultCap / 2) }),
        'tool_result_too_large',
      ],
    ]

    for (const [name, execute, code] of cases) {
      const { env } = makeEnv()
      const app = makeApp(env, {
        buildTools: () => ({
          run: tool({ inputSchema: z.object({}), execute }),
        }),
      })
      const response = await app.request(
        'https://app.test/_deepspace/agent/tools/run',
        { method: 'POST', body: JSON.stringify({ input: {} }) },
        env,
      )
      const body = (await json(response)) as { code: string; error: string }
      expect(response.status, name).toBe(500)
      expect(body.code, name).toBe(code)
      expect(body.error, name).not.toContain('private detail')
    }
  })

  it('rejects output that does not satisfy the output schema', async () => {
    const { env } = makeEnv()
    const app = makeApp(env, {
      buildTools: () => ({
        run: tool({
          inputSchema: z.object({}),
          outputSchema: z.object({ answer: z.string() }),
          execute: async () => JSON.parse('{"answer":7}'),
        }),
      }),
    })

    const response = await app.request(
      'https://app.test/_deepspace/agent/tools/run',
      { method: 'POST', body: JSON.stringify({ input: {} }) },
      env,
    )

    expect(response.status).toBe(500)
    expect(((await json(response)) as { code: string }).code).toBe('invalid_tool_result')
  })

  it('rejects chunked bodies over the cap and makes errors deterministic no-store JSON', async () => {
    const { env } = makeEnv()
    const app = makeApp(env)
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"input":"'))
        controller.enqueue(encoder.encode('x'.repeat(AGENT_TOOL_REQUEST_BODY_CAP)))
        controller.enqueue(encoder.encode('"}'))
        controller.close()
      },
    })
    const streamInit: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      body: stream,
      duplex: 'half',
    }
    const response = await app.fetch(
      new Request('https://app.test/_deepspace/agent/tools/echo', streamInit),
      env,
    )

    expect(response.status).toBe(413)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await json(response)).toEqual({
      ok: false,
      code: 'payload_too_large',
      error: 'The request body is too large.',
    })
  })
})

describe('shared agent transports', () => {
  const base = 'https://app.test/_deepspace/agent'
  const rpc = (method: string, params?: unknown, headers?: Record<string, string>) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  it.each([
    ['{', -32700],
    ['{}', -32600],
    ['{"jsonrpc":"2.0","id":[],"method":"ping"}', -32600],
  ])('reports the appropriate JSON-RPC error for %s', async (body, code) => {
    const { env } = makeEnv()
    const app = makeApp(env)
    const response = await app.request(base + '/mcp', { method: 'POST', body }, env)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code } })
  })
  it('does not replace explicit null input with an executable empty object', async () => {
    const { env } = makeEnv()
    const execute = vi.fn(async () => ({ saved: true }))
    const app = makeApp(env, {
      buildTools: () => ({ save: tool({ inputSchema: z.object({}), execute }) }),
    })
    const response = await app.request(
      base + '/mcp',
      rpc('tools/call', {
        name: 'save',
        arguments: null,
      }),
      env,
    )
    expect(await response.json()).toMatchObject({ error: { code: -32602 } })
    expect(execute).not.toHaveBeenCalled()
  })
  it.each([null, [], 'invalid'])('refuses invalid MCP params %j', async (params) => {
    const { env } = makeEnv()
    const response = await makeApp(env).request(base + '/mcp', rpc('tools/list', params), env)
    expect(await response.json()).toMatchObject({ error: { code: -32602 } })
  })
  it('discovers the same executable definitions through HTTP, Markdown and MCP', async () => {
    const { env } = makeEnv()
    const app = makeApp(env)
    const http = (await (await app.request(base + '/tools', {}, env)).json()) as {
      tools: Array<{ inputSchema: unknown }>
    }
    const mcp = (await (await app.request(base + '/mcp', rpc('tools/list'), env)).json()) as {
      result: { tools: unknown[] }
    }
    expect(mcp.result.tools).toEqual(http.tools)
    const md = await app.request(base + '/tools.md', {}, env)
    expect(md.headers.get('Cache-Control')).toBe('no-store')
    expect(await md.text()).toContain(JSON.stringify(http.tools[0].inputSchema))
    const init = await (
      await app.request(base + '/mcp', rpc('initialize', { protocolVersion: '2025-06-18' }), env)
    ).json()
    expect((init as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      '2025-06-18',
    )
  })
  it('keeps scalar-input tools on HTTP without invalidating MCP discovery', async () => {
    const { env } = makeEnv()
    const app = makeApp(env, {
      buildTools: () => ({
        scalar: tool({ inputSchema: z.string(), execute: async (value) => value }),
        object: tool({ inputSchema: z.object({}), execute: async () => ({ ok: true }) }),
      }),
    })
    const list = (await (await app.request(base + '/mcp', rpc('tools/list'), env)).json()) as {
      result: { tools: Array<{ name: string; inputSchema: { type: string } }> }
    }
    expect(list.result.tools.map((entry) => entry.name)).toEqual(['object'])
    expect(list.result.tools[0].inputSchema.type).toBe('object')
    const response = await app.request(
      base + '/tools/scalar',
      {
        method: 'POST',
        body: JSON.stringify({ input: 'hello' }),
      },
      env,
    )
    expect(await response.json()).toEqual({ ok: true, result: 'hello' })
    expect(
      await (
        await app.request(
          base + '/mcp',
          rpc('tools/call', {
            name: 'scalar',
            arguments: 'hello',
          }),
          env,
        )
      ).json(),
    ).toMatchObject({ error: { code: -32602 } })
  })
  it('refuses an oversized typed output instead of returning schema-invalid success', async () => {
    const { env } = makeEnv()
    const app = makeApp(env, {
      buildTools: () => ({
        list: tool({
          inputSchema: z.object({}),
          outputSchema: z.strictObject({ items: z.array(z.string()).length(1000) }),
          execute: async () => ({ items: Array.from({ length: 1000 }, () => 'x'.repeat(200)) }),
        }),
      }),
    })
    const response = (await (
      await app.request(
        base + '/mcp',
        rpc('tools/call', {
          name: 'list',
          arguments: {},
        }),
        env,
      )
    ).json()) as {
      result: { isError: boolean; structuredContent?: unknown; content: Array<{ text: string }> }
    }
    expect(response.result.isError).toBe(true)
    expect(response.result).not.toHaveProperty('structuredContent')
    expect(JSON.parse(response.result.content[0].text)).toMatchObject({
      code: 'tool_result_too_large',
    })
  })
  const outputCases: Array<{
    name: string
    schema: z.ZodType
    value: unknown
    objectSchema: boolean
  }> = [
    { name: 'number', schema: z.number(), value: 3, objectSchema: false },
    { name: 'string', schema: z.string(), value: 'hello', objectSchema: false },
    { name: 'boolean', schema: z.boolean(), value: true, objectSchema: false },
    { name: 'null', schema: z.null(), value: null, objectSchema: false },
    { name: 'array', schema: z.array(z.number()), value: [1, 2], objectSchema: false },
    {
      name: 'nullable object',
      schema: z.object({ count: z.number() }).nullable(),
      value: { count: 3 },
      objectSchema: false,
    },
    {
      name: 'object',
      schema: z.object({ count: z.number() }),
      value: { count: 3 },
      objectSchema: true,
    },
  ]
  it.each(outputCases)(
    'keeps $name outputs MCP-compatible without changing the HTTP contract',
    async ({ schema, value, objectSchema }) => {
      const { env } = makeEnv()
      const app = makeApp(env, {
        buildTools: () => ({
          result: tool({
            inputSchema: z.object({}),
            outputSchema: schema,
            execute: async () => value,
          }),
        }),
      })
      const httpList = (await (await app.request(base + '/tools', {}, env)).json()) as {
        tools: Array<{ outputSchema: unknown }>
      }
      const mcpList = (await (await app.request(base + '/mcp', rpc('tools/list'), env)).json()) as {
        result: { tools: Array<{ outputSchema?: unknown }> }
      }
      // MCP's Tool schema permits only object-root input and output schemas.
      const mcpSchema = z.object({ type: z.literal('object') }).passthrough()
      expect(
        z
          .array(
            z
              .object({
                name: z.string(),
                inputSchema: mcpSchema,
                outputSchema: mcpSchema.optional(),
              })
              .passthrough(),
          )
          .safeParse(mcpList.result.tools).success,
      ).toBe(true)
      expect(httpList.tools[0].outputSchema).toBeDefined()
      expect(mcpList.result.tools[0].outputSchema).toEqual(
        objectSchema ? httpList.tools[0].outputSchema : undefined,
      )

      const httpCall = await (
        await app.request(base + '/tools/result', { method: 'POST', body: '{"input":{}}' }, env)
      ).json()
      expect(httpCall).toEqual({ ok: true, result: value })
      const mcpCall = (await (
        await app.request(base + '/mcp', rpc('tools/call', { name: 'result', arguments: {} }), env)
      ).json()) as {
        result: { content: Array<{ type: string; text: string }>; structuredContent?: unknown }
      }
      expect(mcpCall.result.content).toEqual([{ type: 'text', text: JSON.stringify(value) }])
      if (objectSchema) expect(mcpCall.result.structuredContent).toEqual(value)
      else if (mcpCall.result.structuredContent !== undefined)
        expect(
          z.record(z.string(), z.unknown()).safeParse(mcpCall.result.structuredContent).success,
        ).toBe(true)
    },
  )
  it('preserves validation and execution results across HTTP and MCP', async () => {
    const { env } = makeEnv()
    const app = makeApp(env)
    for (const input of [{ message: 'hello' }, { message: 7 }, { message: 'hello', typo: true }]) {
      const http = await (
        await app.request(
          base + '/tools/echo',
          { method: 'POST', body: JSON.stringify({ input }) },
          env,
        )
      ).json()
      const mcp = await (
        await app.request(base + '/mcp', rpc('tools/call', { name: 'echo', arguments: input }), env)
      ).json()
      const httpBody = http as { ok: boolean; result?: unknown }
      const mcpBody = mcp as { result: { isError: boolean; content: Array<{ text: string }> } }
      expect(mcpBody.result.isError).toBe(!httpBody.ok)
      expect(JSON.parse(mcpBody.result.content[0].text)).toEqual(
        httpBody.ok ? httpBody.result : httpBody,
      )
    }
  })
  it.each([401, 403, 503] as const)(
    'keeps all discovery and invocation behind the same %i gate',
    async (status) => {
      const { env } = makeEnv()
      const buildTools = vi.fn()
      const app = makeApp(env, { resolveAccess: async () => ({ ok: false, status }), buildTools })
      for (const [path, init] of [
        ['/tools.md', {}],
        ['/mcp', rpc('initialize')],
        ['/mcp', rpc('tools/list')],
        ['/mcp', rpc('tools/call', { name: 'echo', arguments: { message: 'x' } })],
      ] as const)
        expect((await app.request(base + path, init, env)).status).toBe(status)
      expect(buildTools).not.toHaveBeenCalled()
    },
  )
  it('rejects cross-origin requests and oversized MCP bodies before execution', async () => {
    const { env } = makeEnv()
    const execute = vi.fn()
    const app = makeApp(env, {
      buildTools: () => ({
        echo: tool({ inputSchema: z.object({ message: z.string() }), execute }),
      }),
    })
    expect(
      (
        await app.request(
          base + '/mcp',
          rpc('tools/call', { name: 'echo', arguments: {} }, { Origin: 'https://elsewhere.test' }),
          env,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request(
          base + '/mcp',
          rpc('tools/call', {
            name: 'echo',
            arguments: { message: 'x'.repeat(AGENT_TOOL_REQUEST_BODY_CAP) },
          }),
          env,
        )
      ).status,
    ).toBe(413)
    expect(execute).not.toHaveBeenCalled()
  })
  it('does not execute notification calls or advertise an SSE/session transport', async () => {
    const { env } = makeEnv()
    const execute = vi.fn()
    const app = makeApp(env, {
      buildTools: () => ({ echo: tool({ inputSchema: z.object({}), execute }) }),
    })
    const response = await app.request(
      base + '/mcp',
      {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'echo' } }),
      },
      env,
    )
    expect(response.status).toBe(202)
    expect(execute).not.toHaveBeenCalled()
    expect((await app.request(base + '/mcp', {}, env)).status).toBe(405)
  })
  it('does not widen native credentials when browser sessions are enabled', async () => {
    const { env } = makeEnv()
    const app = new Hono<{ Bindings: AgentToolRouteEnv }>()
    registerAgentToolRoutes(app, {
      resolveAccess: async (r) =>
        r.headers.get('Authorization') === 'Bearer native' ? access : { ok: false, status: 401 },
      resolveBrowserAccess: async (r) =>
        r.headers.get('Authorization') === 'Bearer browser' ? access : { ok: false, status: 401 },
      buildTools: (execute) => ({
        current: tool({ inputSchema: z.object({}), execute: () => execute('user.current', {}) }),
      }),
    })
    for (const [path, token, status] of [
      ['', 'browser', 401],
      ['/browser', 'native', 401],
      ['', 'native', 200],
      ['/browser', 'browser', 200],
    ] as const) {
      const response = await app.request(
        base + path + '/tools/current',
        { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{"input":{}}' },
        env,
      )
      expect(response.status).toBe(status)
    }
  })
})
