import { tool, type ToolSet } from 'ai'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import {
  AGENT_TOOL_REQUEST_BODY_CAP,
  AGENT_TOOL_RESPONSE_BODY_CAP,
  registerAgentToolRoutes,
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
    expect(((await json(response)) as { code: string }).code).toBe('invalid_tool_input')
    expect(execute).not.toHaveBeenCalled()
    expect(requests).toEqual([])
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
