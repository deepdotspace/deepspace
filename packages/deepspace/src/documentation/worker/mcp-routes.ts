import type { Hono } from 'hono'
import { documentationPublicPath } from '../routing'
import { documentationSubject } from '../text'
import type { DocumentationCorpusChunk } from './assistant'
import {
  loadDocumentationPublishedManifest,
  resolveDocumentationPublishedCorpus,
  type DocumentationPublishedManifest,
} from './published-corpus'
import { checkDocumentationPublicLimit, documentationPublicClientKey } from './public-limiter'
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
} from './mcp/protocol'
import { callDocumentationTool, DOCUMENTATION_TOOLS } from './mcp/tools'

export interface DocumentationMcpRouteEnv {
  ASSETS: Fetcher
  DEEPSPACE_APP_ID: string
  DOCUMENTATION_CLIENT_RATE_LIMITER?: RateLimit
  DOCUMENTATION_APP_RATE_LIMITER?: RateLimit
}

const MAX_REQUEST_CHARS = 64_000
const MAX_REQUEST_BYTES = MAX_REQUEST_CHARS * 4
const MAX_SKILL_CHARS = 256_000
const DOCUMENTATION_BASE_PATH = '/docs'

/** Register the public, stateless MCP endpoint for a documentation surface. */
export function registerDocumentationMcpRoutes<Env extends DocumentationMcpRouteEnv>(
  app: Hono<{ Bindings: Env }>,
  publicBasePath = DOCUMENTATION_BASE_PATH,
  assetBasePath = '/_documentation',
): void {
  const mcpPath = documentationPublicPath(publicBasePath, '/mcp')
  app.get(mcpPath, async (c) => {
    if (!(await publicManifest(c.req.raw, c.env, assetBasePath))) return c.notFound()
    return new Response(null, {
      status: 405,
      headers: { Allow: 'POST', ...mcpSecurityHeaders() },
    })
  })

  app.post(mcpPath, async (c) => {
    const manifest = await publicManifest(c.req.raw, c.env, assetBasePath)
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
      return mcpResult(requestId, { tools: DOCUMENTATION_TOOLS })
    }
    if (request.method === 'resources/list') {
      return mcpResult(requestId, {
        resources: [skillResource(c.req.raw, manifest, publicBasePath)],
      })
    }
    if (request.method === 'resources/read') {
      return readSkillResource(
        c.req.raw,
        requestWithId,
        manifest,
        c.env,
        publicBasePath,
        assetBasePath,
      )
    }
    if (request.method !== 'tools/call') {
      return mcpError(requestId, -32601, `Method not found: ${request.method}`)
    }

    // The abuse boundary precedes all other per-call work.
    const clientKey = await documentationPublicClientKey(
      c.req.header('CF-Connecting-IP') ?? 'unknown',
    )
    const limitResult = await checkDocumentationPublicLimit(c.env, clientKey, 'documentation-mcp')
    if (!limitResult.ok) {
      return mcpError(
        requestId,
        limitResult.status === 429 ? -32029 : -32002,
        limitResult.status === 429
          ? 'Documentation tool rate limit exceeded. Try again shortly.'
          : 'Documentation tools are temporarily unavailable',
        limitResult.status,
        limitResult.status === 429 ? { 'Retry-After': '60' } : undefined,
      )
    }

    const corpusResult = await resolveDocumentationPublishedCorpus(
      c.env,
      manifest.sourceHash,
      c.req.url,
      assetBasePath,
    )
    if (!corpusResult.ok) {
      console.error('[documentation-mcp] corpus unavailable:', corpusResult.error)
      return mcpError(requestId, -32002, 'Documentation corpus is unavailable', 503)
    }
    const corpus: DocumentationCorpusChunk[] = corpusResult.chunks

    return callDocumentationTool(
      c.req.raw,
      requestWithId,
      corpus,
      c.env,
      publicBasePath,
      assetBasePath,
    )
  })

  for (const path of [
    '/.well-known/mcp',
    '/.well-known/mcp.json',
    '/.well-known/mcp/server-card.json',
  ]) {
    app.get(documentationPublicPath(publicBasePath, path), async (c) => {
      const manifest = await publicManifest(c.req.raw, c.env, assetBasePath)
      if (!manifest) return c.notFound()
      return discoveryResponse(c.req.raw, manifest, publicBasePath)
    })
  }

  app.get(
    documentationPublicPath(publicBasePath, '/.well-known/mcp/server-cards.json'),
    async (c) => {
      const manifest = await publicManifest(c.req.raw, c.env, assetBasePath)
      if (!manifest) return c.notFound()
      return jsonResponse({ servers: [serverCard(c.req.raw, manifest, publicBasePath)] }, 200, {
        'Cache-Control': 'public, max-age=300',
      })
    },
  )
}

async function readSkillResource<Env extends DocumentationMcpRouteEnv>(
  rawRequest: Request,
  request: JsonRpcRequest & { id: JsonRpcId },
  manifest: DocumentationPublishedManifest,
  env: Env,
  publicBasePath: string,
  assetBasePath: string,
): Promise<Response> {
  const params = objectValue(request.params)
  const requestedUri = typeof params?.uri === 'string' ? params.uri : ''
  const resource = skillResource(rawRequest, manifest, publicBasePath)
  if (requestedUri !== resource.uri) {
    return mcpError(request.id, -32602, 'Unknown documentation resource')
  }
  const assetUrl = new URL(`${assetBasePath}/skill.md`, rawRequest.url)
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
  manifest: DocumentationPublishedManifest,
  publicBasePath: string,
): { uri: string; name: string; title: string; description: string; mimeType: string } {
  const subject = documentationSubject(manifest.name)
  return {
    uri: new URL(`${publicBasePath}/skill.md`, request.url).toString(),
    name: `${subject} skill`,
    title: `Use ${manifest.name}`,
    description: `Agent instructions grounded in the published ${subject}.`,
    mimeType: 'text/markdown',
  }
}

async function publicManifest<Env extends DocumentationMcpRouteEnv>(
  request: Request,
  env: Env,
  assetBasePath: string,
): Promise<DocumentationPublishedManifest | null> {
  const manifest = await loadDocumentationPublishedManifest(env, request.url, assetBasePath)
  return manifest?.mcp.access === 'public' ? manifest : null
}

function discoveryResponse(
  request: Request,
  manifest: DocumentationPublishedManifest,
  publicBasePath: string,
): Response {
  return jsonResponse(serverCard(request, manifest, publicBasePath), 200, {
    'Cache-Control': 'public, max-age=300',
  })
}

function serverCard(
  request: Request,
  manifest: DocumentationPublishedManifest,
  publicBasePath: string,
): Record<string, unknown> {
  return {
    name: manifest.name,
    description: `Search and read the published ${documentationSubject(manifest.name)}.`,
    version: MCP_SERVER_VERSION,
    // Preferred version, then everything the handshake will actually accept.
    // Advertising only the preferred one made the card look like it disagreed
    // with `initialize`, which per spec MUST echo a supported version the
    // client asked for rather than force the newest.
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    transport: {
      type: 'streamable-http',
      url: new URL(`${publicBasePath}/mcp`, request.url).toString(),
    },
    authentication: { required: false },
    capabilities: {
      tools: DOCUMENTATION_TOOLS.map(({ name, title, description }) => ({
        name,
        title,
        description,
      })),
      resources: [skillResource(request, manifest, publicBasePath)],
    },
  }
}
