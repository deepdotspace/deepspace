import { searchDocumentationCorpus, type DocumentationCorpusChunk } from '../assistant'
import { documentationPublicPath } from '../../routing'
import { readDocumentationPublishedPage } from '../published-corpus'
import {
  mcpError,
  objectValue,
  toolError,
  toolResult,
  type JsonRpcId,
  type JsonRpcRequest,
} from './protocol'

export interface DocumentationMcpToolEnv {
  ASSETS: Fetcher
  DEEPSPACE_APP_ID: string
}

export const DOCUMENTATION_TOOLS = [
  {
    name: 'documentation_search',
    title: 'Search documentation',
    description: 'Search the published documentation and return ranked, linked excerpts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 300 },
        limit: { type: 'integer', minimum: 1, maximum: 10, default: 6 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { results: { type: 'array' } },
      required: ['results'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'documentation_read',
    title: 'Read documentation page',
    description: 'Read one complete published documentation page as Markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        route: { type: 'string', minLength: 1, maxLength: 500, pattern: '^/' },
      },
      required: ['route'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        route: { type: 'string' },
        title: { type: 'string' },
        url: { type: 'string' },
        markdown: { type: 'string' },
      },
      required: ['route', 'title', 'url', 'markdown'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] as const

export async function callDocumentationTool<Env extends DocumentationMcpToolEnv>(
  rawRequest: Request,
  request: JsonRpcRequest & { id: JsonRpcId },
  corpus: DocumentationCorpusChunk[],
  env: Env,
  basePath = '/docs',
  assetBasePath = '/_documentation',
): Promise<Response> {
  const params = objectValue(request.params)
  const name = typeof params?.name === 'string' ? params.name : ''
  const args = objectValue(params?.arguments) ?? {}
  const origin = new URL(rawRequest.url).origin

  if (name === 'documentation_search') {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const limit = args.limit === undefined ? 6 : args.limit
    if (
      query.length < 2 ||
      query.length > 300 ||
      !Number.isInteger(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 10
    ) {
      return mcpError(request.id, -32602, 'Invalid documentation_search arguments')
    }
    const value = {
      results: searchDocumentationCorpus(corpus, query, Number(limit)).map((result) => ({
        ...result,
        url: new URL(documentationPublicPath(basePath, result.route), origin).toString(),
      })),
    }
    return toolResult(request.id, value)
  }

  if (name === 'documentation_read') {
    const route = typeof args.route === 'string' ? args.route.trim() : ''
    if (!route.startsWith('/') || route.length > 500) {
      return mcpError(request.id, -32602, 'Invalid documentation_read arguments')
    }
    try {
      const page = await readDocumentationPublishedPage(
        env,
        corpus,
        route,
        rawRequest.url,
        assetBasePath,
      )
      if (!page) return toolError(request.id, `No published documentation page exists at ${route}`)
      return toolResult(request.id, {
        ...page,
        url: new URL(documentationPublicPath(basePath, page.route), origin).toString(),
      })
    } catch (error) {
      console.error('[documentation-mcp] page unavailable:', error)
      return toolError(request.id, 'The documentation page could not be read')
    }
  }

  return mcpError(request.id, -32602, `Unknown documentation tool: ${name || '<missing>'}`)
}
