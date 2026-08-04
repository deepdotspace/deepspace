import { searchDocsCorpus, type DocsCorpusChunk } from '../docs-assistant'
import { readDocsPublishedPage } from '../docs-published-corpus'
import {
  mcpError,
  objectValue,
  toolError,
  toolResult,
  type JsonRpcId,
  type JsonRpcRequest,
} from './protocol'

export interface DocsMcpToolEnv {
  ASSETS: Fetcher
  DEEPSPACE_APP_ID: string
}

export const DOCS_TOOLS = [
  {
    name: 'docs_search',
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
    name: 'docs_read',
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

export async function callDocsTool<Env extends DocsMcpToolEnv>(
  rawRequest: Request,
  request: JsonRpcRequest & { id: JsonRpcId },
  corpus: DocsCorpusChunk[],
  env: Env,
): Promise<Response> {
  const params = objectValue(request.params)
  const name = typeof params?.name === 'string' ? params.name : ''
  const args = objectValue(params?.arguments) ?? {}
  const origin = new URL(rawRequest.url).origin

  if (name === 'docs_search') {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const limit = args.limit === undefined ? 6 : args.limit
    if (
      query.length < 2 ||
      query.length > 300 ||
      !Number.isInteger(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 10
    ) {
      return mcpError(request.id, -32602, 'Invalid docs_search arguments')
    }
    const value = {
      results: searchDocsCorpus(corpus, query, Number(limit)).map((result) => ({
        ...result,
        url: new URL(result.route, origin).toString(),
      })),
    }
    return toolResult(request.id, value)
  }

  if (name === 'docs_read') {
    const route = typeof args.route === 'string' ? args.route.trim() : ''
    if (!route.startsWith('/') || route.length > 500) {
      return mcpError(request.id, -32602, 'Invalid docs_read arguments')
    }
    try {
      const page = await readDocsPublishedPage(env, corpus, route, rawRequest.url)
      if (!page) return toolError(request.id, `No published documentation page exists at ${route}`)
      return toolResult(request.id, {
        ...page,
        url: new URL(page.route, origin).toString(),
      })
    } catch (error) {
      console.error('[docs-mcp] page unavailable:', error)
      return toolError(request.id, 'The documentation page could not be read')
    }
  }

  return mcpError(request.id, -32602, `Unknown documentation tool: ${name || '<missing>'}`)
}

