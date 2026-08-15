import type { Context, Hono } from 'hono'
import { resolveDeepSpaceAgentModel } from '../../shared/ai-models'
import type { DeepSpaceAIEnv } from '../../server/utils/ai'
import { deepSpaceAgentErrorSummary, streamDeepSpaceAgent } from '../../server/utils/agent'
import { canonicalNativeDocumentationRequestPath } from '../resource-path'
import {
  buildDocumentationAssistantPrompt,
  buildDocumentationAssistantTools,
  type DocumentationCorpusChunk,
} from './assistant'
import {
  loadDocumentationPublishedManifest,
  resolveDocumentationPublishedCorpus,
} from './published-corpus'
import { checkDocumentationPublicLimit, documentationPublicClientKey } from './public-limiter'
import { readBoundedRequestText, RequestBodyTooLargeError } from './request-body'
export interface DocumentationAssistantRouteEnv extends DeepSpaceAIEnv {
  ASSETS: Fetcher
  APP_NAME: string
  DEEPSPACE_APP_ID: string
  DOCUMENTATION_CLIENT_RATE_LIMITER?: RateLimit
  DOCUMENTATION_APP_RATE_LIMITER?: RateLimit
}

const MAX_QUESTION_CHARS = 4_000
const MAX_HISTORY_MESSAGES = 12
const MAX_HISTORY_CHARS = 20_000
const MAX_REQUEST_BYTES = 128 * 1024

interface DocumentationAssistantRequestBody {
  question?: unknown
  route?: unknown
  messages?: unknown
}

/** Register the standard, read-only documentation assistant endpoint. */
export function registerDocumentationAssistantRoutes<Env extends DocumentationAssistantRouteEnv>(
  app: Hono<{ Bindings: Env }>,
  resolveAuth: (request: Request, env: Env) => Promise<unknown | null>,
  publicBasePath = '/docs',
  assetBasePath = '/_documentation',
): void {
  app.post(`${publicBasePath}/api/ai`, async (c) => {
    const manifest = await loadDocumentationPublishedManifest(c.env, c.req.url, assetBasePath)
    if (!manifest || manifest.assistant.access === 'disabled') return c.notFound()

    let authToken: string | undefined
    let publicClientKey: string | undefined
    if (manifest.assistant.access === 'authenticated') {
      const auth = await resolveAuth(c.req.raw, c.env)
      if (!auth) return c.json({ error: 'Sign in required' }, 401)
      const header = c.req.header('Authorization') ?? ''
      if (!header.startsWith('Bearer ')) return c.json({ error: 'Sign in required' }, 401)
      authToken = header.slice(7)
    } else {
      if (!c.env.APP_OWNER_JWT) {
        return c.json({ error: 'Public documentation assistant billing is not configured' }, 503)
      }
      publicClientKey = await documentationPublicClientKey(
        c.req.header('CF-Connecting-IP') ?? 'unknown',
      )
    }

    // The abuse boundary precedes all other per-request work.
    const limitResult = publicClientKey
      ? await checkDocumentationPublicLimit(c.env, publicClientKey, 'documentation-assistant')
      : undefined
    if (limitResult && !limitResult.ok) {
      return c.json(
        {
          error:
            limitResult.status === 429
              ? 'Documentation assistant rate limit exceeded. Try again shortly.'
              : 'Documentation assistant is temporarily unavailable',
        },
        limitResult.status,
        limitResult.status === 429 ? { 'Retry-After': '60' } : undefined,
      )
    }

    let body: DocumentationAssistantRequestBody | null = null
    try {
      const raw = await readBoundedRequestText(c.req.raw, MAX_REQUEST_BYTES)
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as DocumentationAssistantRequestBody
      }
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return c.json({ error: `request exceeds ${MAX_REQUEST_BYTES} bytes` }, 413)
      }
      return c.json({ error: 'request body must be valid JSON' }, 400)
    }
    const question = typeof body?.question === 'string' ? body.question.trim() : ''
    if (!question) return c.json({ error: 'question is required' }, 400)
    if (question.length > MAX_QUESTION_CHARS) {
      return c.json({ error: `question exceeds ${MAX_QUESTION_CHARS} characters` }, 413)
    }
    const route =
      typeof body?.route === 'string' && body.route.startsWith('/')
        ? body.route.slice(0, 500)
        : undefined
    let history: DocumentationAssistantHistoryMessage[]
    try {
      history = normalizeDocumentationAssistantHistory(body?.messages)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'messages are invalid' }, 400)
    }

    const corpusResult = await resolveDocumentationPublishedCorpus(
      c.env,
      manifest.sourceHash,
      c.req.url,
      assetBasePath,
    )
    if (!corpusResult.ok) {
      console.error('[documentation-assistant] corpus unavailable:', corpusResult.error)
      return c.json({ error: 'Documentation corpus is unavailable' }, 503)
    }
    const corpus: DocumentationCorpusChunk[] = corpusResult.chunks

    const selectedModel = resolveDeepSpaceAgentModel(manifest.assistant.model, 'documentation')
    if (!selectedModel) {
      console.error(
        '[documentation-assistant] unsupported configured model:',
        manifest.assistant.model,
      )
      return c.json({ error: 'Documentation assistant model is not supported' }, 503)
    }
    const diagnosticContext = {
      profile: 'documentation' as const,
      provider: selectedModel.provider,
      modelId: selectedModel.modelId,
    }

    let result
    try {
      result = streamDeepSpaceAgent(c.env, {
        profile: 'documentation',
        modelId: selectedModel.modelId,
        ...(authToken ? { authToken } : {}),
        system: buildDocumentationAssistantPrompt(manifest.name || c.env.APP_NAME, route),
        messages: [...history, { role: 'user' as const, content: question }],
        tools: buildDocumentationAssistantTools(corpus, publicBasePath),
        abortSignal: c.req.raw.signal,
        onError: ({ error }) => {
          console.error(
            `[documentation-assistant] stream error: ${deepSpaceAgentErrorSummary(error, diagnosticContext)}`,
          )
        },
      }).result
    } catch (error) {
      console.error(
        `[documentation-assistant] agent unavailable: ${deepSpaceAgentErrorSummary(error, diagnosticContext)}`,
      )
      return c.json({ error: 'Documentation assistant is not configured' }, 503)
    }

    return result.toUIMessageStreamResponse({
      sendReasoning: false,
      onError: (error) => {
        console.error(
          `[documentation-assistant] response error: ${deepSpaceAgentErrorSummary(error, diagnosticContext)}`,
        )
        return 'The documentation assistant could not complete this response.'
      },
    })
  })
}

/** Preserve useful provider diagnostics in Workers-for-Platforms string logs. */
export const documentationAssistantErrorSummary = deepSpaceAgentErrorSummary

export interface DocumentationAssistantHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Accept only the completed, alternating UI turns that precede the current
 * question. The browser remains stateless; the shared agent runner receives a
 * bounded ephemeral transcript on each request.
 */
export function normalizeDocumentationAssistantHistory(
  value: unknown,
): DocumentationAssistantHistoryMessage[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError('messages must be an array')
  if (value.length > MAX_HISTORY_MESSAGES) {
    throw new TypeError(`messages exceeds ${MAX_HISTORY_MESSAGES} turns`)
  }
  const messages: DocumentationAssistantHistoryMessage[] = []
  let totalChars = 0
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`messages[${index}] must be an object`)
    }
    const candidate = item as Record<string, unknown>
    const expectedRole = index % 2 === 0 ? 'user' : 'assistant'
    if (candidate.role !== expectedRole) {
      throw new TypeError(`messages[${index}].role must be ${expectedRole}`)
    }
    const content = typeof candidate.content === 'string' ? candidate.content.trim() : ''
    if (!content) throw new TypeError(`messages[${index}].content is required`)
    if (content.length > MAX_QUESTION_CHARS) {
      throw new TypeError(`messages[${index}].content exceeds ${MAX_QUESTION_CHARS} characters`)
    }
    totalChars += content.length
    if (totalChars > MAX_HISTORY_CHARS) {
      throw new TypeError(`messages exceeds ${MAX_HISTORY_CHARS} characters`)
    }
    messages.push({ role: expectedRole, content })
  }
  if (messages.length % 2 !== 0) {
    throw new TypeError('messages must end with a completed assistant response')
  }
  return messages
}

/**
 * Own the public documentation route before an existing app's SPA wildcard.
 * Generated assets remain private under `/_documentation`; this adapter is the
 * only place public request paths are translated into that namespace.
 */
export function registerDocumentationStaticRoutes<
  Env extends Pick<DocumentationAssistantRouteEnv, 'ASSETS'>,
>(app: Hono<{ Bindings: Env }>, publicBasePath = '/docs', assetBasePath = '/_documentation'): void {
  const serve = async (c: Context<{ Bindings: Env }>, next: () => Promise<void>) => {
    const manifest = await loadDocumentationPublishedManifest(c.env, c.req.url, assetBasePath)
    if (!manifest) return next()
    const requestUrl = new URL(c.req.url)
    const pathname = requestUrl.pathname
    const publishedPath = documentationRequestPath(pathname, publicBasePath)
    let response: Response
    let status: number
    if (
      publishedPath &&
      isPublishedDocumentationRequest(publishedPath, manifest.routes, manifest.resources)
    ) {
      requestUrl.pathname = documentationAssetPath(publishedPath, manifest.resources, assetBasePath)
      response = await fetchDocumentationAsset(c.env, c.req.raw, requestUrl, assetBasePath)
      status = response.status
    } else {
      response = new Response(null, { status: 404 })
      status = 404
    }
    if (status === 404) {
      // Markdown requests come from agents; the styled 404 page is noise to them.
      if (pathname.endsWith('.md')) {
        return secureDocumentationResponse(
          new Response(
            `No documentation page at ${pathname}. See ${publicBasePath}/llms.txt for every published page.\n`,
            { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
          ),
          404,
          pathname,
        )
      }
      const url = new URL(c.req.url)
      url.pathname = `${assetBasePath}/404.html`
      response = await fetchDocumentationAsset(c.env, c.req.raw, url, assetBasePath)
      status = 404
    }
    return secureDocumentationResponse(response, status, pathname)
  }
  app.get(publicBasePath || '/', serve)
  app.get(`${publicBasePath}/*`, serve)
}

function isPublishedDocumentationRequest(
  publishedPath: string,
  routes: readonly string[],
  resources: readonly string[],
): boolean {
  return routes.includes(publishedPath) || resources.includes(publishedPath)
}

function documentationRequestPath(pathname: string, publicBasePath: string): string | null {
  const logical =
    pathname === publicBasePath || (!publicBasePath && pathname === '/')
      ? '/'
      : pathname.slice(publicBasePath.length) || '/'
  const clean = logical === '/' ? '/' : logical.replace(/\/$/, '')
  return canonicalNativeDocumentationRequestPath(clean)
}

async function fetchDocumentationAsset<Env extends Pick<DocumentationAssistantRouteEnv, 'ASSETS'>>(
  env: Env,
  request: Request,
  initialUrl: URL,
  assetBasePath: string,
): Promise<Response> {
  let url = initialUrl
  for (let redirects = 0; redirects < 3; redirects++) {
    const response = await env.ASSETS.fetch(new Request(url, request))
    const location = response.headers.get('Location')
    if (response.status < 300 || response.status >= 400 || !location) return response
    const next = new URL(location, url)
    if (next.origin !== url.origin || !next.pathname.startsWith(`${assetBasePath}/`)) {
      return new Response('Invalid documentation asset redirect', { status: 502 })
    }
    await response.body?.cancel()
    url = next
  }
  return new Response('Documentation asset redirect loop', { status: 508 })
}

function documentationAssetPath(
  publishedPath: string,
  resources: readonly string[],
  assetBasePath: string,
): string {
  if (publishedPath === '/') return `${assetBasePath}/index.html`
  return resources.includes(publishedPath)
    ? `${assetBasePath}${publishedPath}`
    : `${assetBasePath}${publishedPath}/index.html`
}

function secureDocumentationResponse(
  response: Response,
  status: number,
  pathname: string,
): Response {
  const headers = new Headers(response.headers)
  if (status !== 404 && pathname.endsWith('.md')) {
    headers.set('Content-Type', 'text/markdown; charset=utf-8')
  }
  if (headers.get('Content-Type')?.toLowerCase().includes('text/html')) {
    const cacheControl = headers.get('Cache-Control') ?? 'public, max-age=0, must-revalidate'
    if (!/(?:^|,)\s*no-transform(?:\s*,|$)/i.test(cacheControl)) {
      headers.set('Cache-Control', `${cacheControl}, no-transform`)
    }
  }
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https:; font-src 'self' data: https:; connect-src 'self' https:; " +
      "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  )
  return new Response(response.body, { status, headers })
}
