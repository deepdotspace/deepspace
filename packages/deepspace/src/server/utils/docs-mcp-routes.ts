import type { Hono } from 'hono'
import type { DocsCorpusChunk } from './docs-assistant'
import {
  loadDocsPublishedManifest,
  resolveDocsPublishedCorpus,
  type DocsPublishedManifest,
} from './docs-published-corpus'
import {
  acquireDocsPublicLease,
  docsPublicClientKey,
  releaseDocsPublicLease,
} from './docs-public-limiter'
import { readBoundedRequestText, RequestBodyTooLargeError } from './request-body'
import {
  CURRENT_PROTOCOL_VERSION,
  MCP_SERVER_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  hasValidOrigin,
  initializeResponse,
  jsonResponse,
  mcpError,
  mcpResult,
  mcpSecurityHeaders,
  objectValue,
  parseRequest,
  type JsonRpcId,
  type JsonRpcRequest,
} from './docs-mcp/protocol'
import { callDocsTool, DOCS_TOOLS } from './docs-mcp/tools'

export interface DocsMcpRouteEnv {
  ASSETS: Fetcher
  DEEPSPACE_APP_ID: string
  DOCS_ASSISTANT_LIMITER: DurableObjectNamespace
}

const MAX_REQUEST_CHARS = 64_000
const MAX_REQUEST_BYTES = MAX_REQUEST_CHARS * 4
const MAX_SKILL_CHARS = 256_000


/** Register the public, stateless MCP endpoint for a documentation surface. */
export function registerDocsMcpRoutes<Env extends DocsMcpRouteEnv>(
  app: Hono<{ Bindings: Env }>,
): void {
  app.get('/mcp', async (c) => {
    if (!(await publicManifest(c.req.raw, c.env))) return c.notFound()
    return new Response(null, {
      status: 405,
      headers: { Allow: 'POST', ...mcpSecurityHeaders() },
    })
  })

  app.post('/mcp', async (c) => {
    const manifest = await publicManifest(c.req.raw, c.env)
    if (!manifest) return c.notFound()
    if (!hasValidOrigin(c.req.raw)) {
      return mcpError(null, -32000, 'Invalid Origin', 403)
    }

    let raw: string
    try {
      raw = await readBoundedRequestText(c.req.raw, MAX_REQUEST_BYTES)
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return mcpError(null, -32600, `Request exceeds ${MAX_REQUEST_BYTES} bytes`, 413)
      }
      return mcpError(null, -32700, 'Unable to read request body', 400)
    }
    if (raw.length > MAX_REQUEST_CHARS) {
      return mcpError(null, -32600, `Request exceeds ${MAX_REQUEST_CHARS} characters`, 413)
    }
    const parsed = parseRequest(raw)
    if (!parsed.ok) return mcpError(null, -32700, parsed.message, 400)
    const request = parsed.request

    if (request.method !== 'initialize') {
      const protocolVersion = c.req.header('MCP-Protocol-Version')
      if (protocolVersion && !SUPPORTED_PROTOCOL_VERSIONS.has(protocolVersion)) {
        return mcpError(request.id ?? null, -32600, 'Unsupported MCP-Protocol-Version', 400)
      }
    }

    const requestId = request.id
    if (requestId === undefined) return new Response(null, { status: 202 })
    const requestWithId = { ...request, id: requestId }
    if (request.method === 'initialize') return initializeResponse(requestWithId)
    if (request.method === 'ping') return mcpResult(requestId, {})

    if (request.method === 'tools/list') {
      return mcpResult(requestId, { tools: DOCS_TOOLS })
    }
    if (request.method === 'resources/list') {
      return mcpResult(requestId, { resources: [skillResource(c.req.raw, manifest)] })
    }
    if (request.method === 'resources/read') {
      return readSkillResource(c.req.raw, requestWithId, manifest, c.env)
    }
    if (request.method !== 'tools/call') {
      return mcpError(requestId, -32601, `Method not found: ${request.method}`)
    }

    const corpusResult = await resolveDocsPublishedCorpus(c.env, manifest.sourceHash, c.req.url)
    if (!corpusResult.ok) {
      console.error('[docs-mcp] corpus unavailable:', corpusResult.error)
      return mcpError(requestId, -32002, 'Documentation corpus is unavailable', 503)
    }
    const corpus: DocsCorpusChunk[] = corpusResult.chunks

    const clientKey = await docsPublicClientKey(c.req.header('CF-Connecting-IP') ?? 'unknown')
    const leaseResult = await acquireDocsPublicLease(c.env, clientKey, 'docs-mcp')
    if (!leaseResult.ok) {
      return mcpError(
        requestId,
        leaseResult.status === 429 ? -32029 : -32002,
        leaseResult.status === 429
          ? 'Documentation tool rate limit exceeded. Try again shortly.'
          : 'Documentation tools are temporarily unavailable',
        leaseResult.status,
        leaseResult.status === 429 ? { 'Retry-After': '60' } : undefined,
      )
    }

    try {
      return await callDocsTool(c.req.raw, requestWithId, corpus, c.env)
    } finally {
      await releaseDocsPublicLease(leaseResult.lease, 'docs-mcp')
    }
  })

  for (const path of [
    '/.well-known/mcp',
    '/.well-known/mcp.json',
    '/.well-known/mcp/server-card.json',
  ]) {
    app.get(path, async (c) => {
      const manifest = await publicManifest(c.req.raw, c.env)
      if (!manifest) return c.notFound()
      return discoveryResponse(c.req.raw, manifest)
    })
  }

  app.get('/.well-known/mcp/server-cards.json', async (c) => {
    const manifest = await publicManifest(c.req.raw, c.env)
    if (!manifest) return c.notFound()
    return jsonResponse({ servers: [serverCard(c.req.raw, manifest)] }, 200, {
      'Cache-Control': 'public, max-age=300',
    })
  })
}



async function readSkillResource<Env extends DocsMcpRouteEnv>(
  rawRequest: Request,
  request: JsonRpcRequest & { id: JsonRpcId },
  manifest: DocsPublishedManifest,
  env: Env,
): Promise<Response> {
  const params = objectValue(request.params)
  const requestedUri = typeof params?.uri === 'string' ? params.uri : ''
  const resource = skillResource(rawRequest, manifest)
  if (requestedUri !== resource.uri) {
    return mcpError(request.id, -32602, 'Unknown documentation resource')
  }
  const assetUrl = new URL('/_docs/skill.md', rawRequest.url)
  const response = await env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }))
  if (!response.ok) return mcpError(request.id, -32002, 'Documentation skill is unavailable', 503)
  const text = await response.text()
  if (text.length > MAX_SKILL_CHARS) {
    return mcpError(request.id, -32002, 'Documentation skill exceeds the published size limit', 503)
  }
  return mcpResult(request.id, {
    contents: [{ uri: resource.uri, mimeType: resource.mimeType, text }],
  })
}

function skillResource(
  request: Request,
  manifest: DocsPublishedManifest,
): { uri: string; name: string; title: string; description: string; mimeType: string } {
  return {
    uri: new URL('/skill.md', request.url).toString(),
    name: `${manifest.name} documentation skill`,
    title: `Use ${manifest.name}`,
    description: `Agent instructions grounded in the published ${manifest.name} documentation.`,
    mimeType: 'text/markdown',
  }
}

async function publicManifest<Env extends DocsMcpRouteEnv>(
  request: Request,
  env: Env,
): Promise<DocsPublishedManifest | null> {
  if (request.headers.get('x-deepspace-surface') !== 'docs') return null
  const manifest = await loadDocsPublishedManifest(env, request.url)
  return manifest?.mcp.access === 'public' ? manifest : null
}


function discoveryResponse(request: Request, manifest: DocsPublishedManifest): Response {
  return jsonResponse(serverCard(request, manifest), 200, {
    'Cache-Control': 'public, max-age=300',
  })
}

function serverCard(request: Request, manifest: DocsPublishedManifest): Record<string, unknown> {
  return {
    name: manifest.name,
    description: `Search and read the published ${manifest.name} documentation.`,
    version: MCP_SERVER_VERSION,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    transport: {
      type: 'streamable-http',
      url: new URL('/mcp', request.url).toString(),
    },
    authentication: { required: false },
    capabilities: {
      tools: DOCS_TOOLS.map(({ name, title, description }) => ({ name, title, description })),
      resources: [skillResource(request, manifest)],
    },
  }
}
