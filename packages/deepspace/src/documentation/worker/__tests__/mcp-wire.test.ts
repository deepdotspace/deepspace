/**
 * Wire tests for the public documentation MCP endpoint.
 *
 * Unlike the protocol unit tests, these exercise the real HTTP surface:
 * requests leave `deepspace/testing/mcp` as bytes and reach the registered
 * routes through the worker-facing `app.fetch`, so status codes, headers,
 * and body shapes are asserted exactly as a network MCP client observes them.
 */

import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createMcpTestClient, McpRpcError, McpTransportError } from '../../../testing/mcp'
import { registerDocumentationMcpRoutes, type DocumentationMcpRouteEnv } from '../mcp-routes'
import { CURRENT_PROTOCOL_VERSION } from '../mcp/protocol'

interface WireExchange {
  request: Request
  response: Response
}

function wireServer(mcpAccess: 'public' | 'disabled' = 'public') {
  const app = new Hono<{ Bindings: DocumentationMcpRouteEnv }>()
  registerDocumentationMcpRoutes(app)
  const env = {
    DEEPSPACE_APP_ID: 'app_wire',
    DOCUMENTATION_CLIENT_RATE_LIMITER: { limit: async () => ({ success: true }) },
    DOCUMENTATION_APP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ASSETS: {
      fetch: async (input: Request | string) => {
        const pathname = new URL(typeof input === 'string' ? input : input.url).pathname
        if (pathname === '/_documentation/manifest.json') {
          return Response.json({
            version: 2,
            sourceHash: 'wire',
            name: 'Example',
            routes: ['/', '/guides/start'],
            resources: [],
            assistant: { access: 'disabled' },
            mcp: { access: mcpAccess },
          })
        }
        if (pathname === '/_documentation/assistant-index.json') {
          return Response.json([
            { id: 'home', route: '/', title: 'Example', text: 'Welcome to the example docs.' },
            {
              id: 'start',
              route: '/guides/start',
              title: 'Getting started',
              heading: 'Install',
              text: 'Install the SDK, then start the local dev server.',
            },
          ])
        }
        if (pathname === '/_documentation/guides/start.md') {
          return new Response(
            '# Getting started\n\n## Install\n\nRun the install command.\n\n' +
              '### Requirements\n\nNode and npm.\n\n## Deploy\n\nShip it.\n',
          )
        }
        return new Response(null, { status: 404 })
      },
    },
  } as unknown as DocumentationMcpRouteEnv

  const exchanges: WireExchange[] = []
  const wireFetch: typeof fetch = async (input, init) => {
    // The client only ever sends a string URL; normalizing here keeps the
    // recorded Request clear of workers-types' Cf-generic variance.
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const request = new Request(url, init)
    const response = await app.fetch(request, env)
    exchanges.push({ request, response })
    return response
  }
  return {
    client: createMcpTestClient('https://docs.test', { endpoint: '/docs/mcp', fetch: wireFetch }),
    exchanges,
  }
}

describe('documentation MCP over the wire', () => {
  it('initializes, echoes the negotiated version, lists tools, and searches', async () => {
    const { client, exchanges } = wireServer()

    const initialized = await client.initialize()
    expect(initialized.protocolVersion).toBe(CURRENT_PROTOCOL_VERSION)
    expect(initialized.serverInfo.name).toBe('DeepSpace Documentation')
    expect(client.protocolVersion).toBe(CURRENT_PROTOCOL_VERSION)
    // Negotiation precedes the header: `initialize` itself must not carry it.
    expect(exchanges.at(-1)?.request.headers.get('MCP-Protocol-Version')).toBeNull()

    const tools = await client.listTools()
    expect(tools.map(({ name }) => name)).toEqual(['documentation_search', 'documentation_read'])
    expect(exchanges.at(-1)?.request.headers.get('MCP-Protocol-Version')).toBe(
      CURRENT_PROTOCOL_VERSION,
    )

    const search = await client.callTool('documentation_search', { query: 'install' })
    expect(search.isError).toBe(false)
    expect(search.structuredContent).toMatchObject({
      results: [
        {
          route: '/guides/start',
          title: 'Getting started',
          url: 'https://docs.test/docs/guides/start',
          termCoverage: 1,
        },
      ],
    })
    expect(search.structuredContent?.notice).toBeUndefined()
  })

  it('flags searches whose best hit does not cover the query as weak', async () => {
    const { client } = wireServer()
    await client.initialize()

    const partial = await client.callTool('documentation_search', {
      query: 'install kubernetes cluster',
    })
    expect(partial.isError).toBe(false)
    expect(partial.structuredContent?.notice).toBe(
      'No section matches every search term — the topic may be absent or spread across sections.',
    )
    expect(partial.structuredContent?.results).toMatchObject([{ route: '/guides/start' }])
    // The marker leads the serialized content an agent reads first.
    expect(partial.content[0]?.text?.startsWith('{"notice":"No section')).toBe(true)

    const absent = await client.callTool('documentation_search', { query: 'kubernetes' })
    expect(absent.structuredContent).toMatchObject({
      notice: 'No section matches every search term — the topic may be absent or spread across sections.',
      results: [],
    })
  })

  it('reads a fragment as its section, notes unknown fragments, and accepts slash-less routes', async () => {
    const { client } = wireServer()
    await client.initialize()

    const section = await client.callTool('documentation_read', {
      route: '/guides/start#install',
    })
    expect(section.isError).toBe(false)
    expect(section.structuredContent).toMatchObject({
      route: '/guides/start',
      url: 'https://docs.test/docs/guides/start',
      markdown: '## Install\n\nRun the install command.\n\n### Requirements\n\nNode and npm.',
    })
    expect(section.structuredContent?.notice).toBeUndefined()

    const unknown = await client.callTool('documentation_read', { route: '/guides/start#nope' })
    expect(unknown.isError).toBe(false)
    expect(unknown.structuredContent?.notice).toBe(
      'The fragment #nope was not found; returning the whole page.',
    )
    expect(unknown.structuredContent?.markdown).toContain('## Deploy')

    const slashless = await client.callTool('documentation_read', { route: 'guides/start' })
    expect(slashless.isError).toBe(false)
    expect(slashless.structuredContent).toMatchObject({
      route: '/guides/start',
      title: 'Getting started',
    })
  })

  it('captures the version the server negotiated, not the one it was asked for', async () => {
    const { client } = wireServer()
    await client.initialize({ protocolVersion: 'unsupported-by-this-server' })
    expect(client.protocolVersion).toBe(CURRENT_PROTOCOL_VERSION)
  })

  it('delivers notifications and resolves on the wire 202 with a null body', async () => {
    const { client, exchanges } = wireServer()
    await client.initialize()
    await expect(client.notify('notifications/initialized')).resolves.toBeUndefined()
    const exchange = exchanges.at(-1)
    expect(exchange?.request.headers.get('MCP-Protocol-Version')).toBe(CURRENT_PROTOCOL_VERSION)
    expect(exchange?.response.status).toBe(202)
    expect(exchange?.response.body).toBeNull()
  })

  it('rejects an unsupported MCP-Protocol-Version header with HTTP 400', async () => {
    const { client } = wireServer()
    await client.initialize()
    client.protocolVersion = 'unsupported-by-this-server'
    const failure = await client.listTools().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpRpcError)
    const rpcError = failure as McpRpcError
    expect(rpcError.status).toBe(400)
    expect(rpcError.code).toBe(-32600)
    expect(rpcError.message).toBe('Unsupported MCP-Protocol-Version')
  })

  it('surfaces JSON-RPC error objects as typed throws', async () => {
    const { client } = wireServer()
    await client.initialize()
    const failure = await client
      .callTool('documentation_search', { query: 'x' })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpRpcError)
    const rpcError = failure as McpRpcError
    expect(rpcError.code).toBe(-32602)
    expect(rpcError.status).toBe(200)
    expect(rpcError.message).toBe('Invalid documentation_search arguments')
  })

  it('reports status and body head when a disabled surface answers with non-JSON', async () => {
    const { client } = wireServer('disabled')
    const failure = await client.initialize().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpTransportError)
    const transportError = failure as McpTransportError
    expect(transportError.status).toBe(404)
    expect(transportError.bodyHead).toContain('404')
  })
})
