import type { Hono } from 'hono'
import { resolveDeepSpaceAgentModel } from '../../shared/ai-models'
import type { DeepSpaceAIEnv } from './ai'
import { deepSpaceAgentErrorSummary, streamDeepSpaceAgent } from './agent'
import {
  buildDocsAssistantPrompt,
  buildDocsAssistantTools,
  type DocsCorpusChunk,
} from './docs-assistant'
import { loadDocsPublishedManifest, resolveDocsPublishedCorpus } from './docs-published-corpus'
import {
  acquireDocsPublicLease,
  docsPublicClientKey,
  releaseDocsPublicLease,
  type DocsPublicLease,
} from './docs-public-limiter'
import { readBoundedRequestText, RequestBodyTooLargeError } from './request-body'
export interface DocsAssistantRouteEnv extends DeepSpaceAIEnv {
  ASSETS: Fetcher
  APP_NAME: string
  DEEPSPACE_APP_ID: string
  DOCS_ASSISTANT_LIMITER: DurableObjectNamespace
}

const MAX_QUESTION_CHARS = 4_000
const MAX_HISTORY_MESSAGES = 12
const MAX_HISTORY_CHARS = 20_000
const MAX_REQUEST_BYTES = 128 * 1024

interface DocsAssistantRequestBody {
  question?: unknown
  route?: unknown
  messages?: unknown
}

/** Register the standard, read-only documentation assistant endpoint. */
export function registerDocsAssistantRoutes<Env extends DocsAssistantRouteEnv>(
  app: Hono<{ Bindings: Env }>,
  resolveAuth: (request: Request, env: Env) => Promise<unknown | null>,
): void {
  app.post('/api/ai/docs', async (c) => {
    if (c.req.header('x-deepspace-surface') !== 'docs') return c.notFound()
    const manifest = await loadDocsPublishedManifest(c.env, c.req.url)
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
      publicClientKey = await docsPublicClientKey(c.req.header('CF-Connecting-IP') ?? 'unknown')
    }

    let body: DocsAssistantRequestBody | null = null
    try {
      const raw = await readBoundedRequestText(c.req.raw, MAX_REQUEST_BYTES)
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as DocsAssistantRequestBody
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
    const route = typeof body?.route === 'string' && body.route.startsWith('/')
      ? body.route.slice(0, 500)
      : undefined
    let history: DocsAssistantHistoryMessage[]
    try {
      history = normalizeDocsAssistantHistory(body?.messages)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'messages are invalid' }, 400)
    }

    const corpusResult = await resolveDocsPublishedCorpus(c.env, manifest.sourceHash, c.req.url)
    if (!corpusResult.ok) {
      console.error('[docs-assistant] corpus unavailable:', corpusResult.error)
      return c.json({ error: 'Documentation corpus is unavailable' }, 503)
    }
    const corpus: DocsCorpusChunk[] = corpusResult.chunks

    const selectedModel = resolveDeepSpaceAgentModel(
      manifest.assistant.model,
      'documentation',
    )
    if (!selectedModel) {
      console.error('[docs-assistant] unsupported configured model:', manifest.assistant.model)
      return c.json({ error: 'Documentation assistant model is not supported' }, 503)
    }
    const diagnosticContext = {
      profile: 'documentation' as const,
      provider: selectedModel.provider,
      modelId: selectedModel.modelId,
    }

    if (publicClientKey && !c.env.DOCS_ASSISTANT_LIMITER) {
      return c.json({ error: 'Documentation assistant rate limiting is not configured' }, 503)
    }
    const leaseResult = publicClientKey
      ? await acquireDocsPublicLease(c.env, publicClientKey, 'docs-assistant')
      : undefined
    if (leaseResult && !leaseResult.ok) {
      return c.json(
        {
          error: leaseResult.status === 429
            ? 'Documentation assistant rate limit exceeded. Try again shortly.'
            : 'Documentation assistant is temporarily unavailable',
        },
        leaseResult.status,
        leaseResult.status === 429 ? { 'Retry-After': '60' } : undefined,
      )
    }
    const lease: DocsPublicLease | undefined = leaseResult?.ok ? leaseResult.lease : undefined
    let released = false
    const releaseLease = async (): Promise<void> => {
      if (!lease || released) return
      released = true
      await releaseDocsPublicLease(lease, 'docs-assistant')
    }

    let result
    try {
      result = streamDeepSpaceAgent(c.env, {
        profile: 'documentation',
        modelId: selectedModel.modelId,
        ...(authToken ? { authToken } : {}),
        system: buildDocsAssistantPrompt(manifest.name || c.env.APP_NAME, route),
        messages: [...history, { role: 'user' as const, content: question }],
        tools: buildDocsAssistantTools(corpus),
        abortSignal: c.req.raw.signal,
        onAbort: () => releaseLease(),
        onFinish: releaseLease,
        onError: ({ error }) => {
          console.error(
            `[docs-assistant] stream error: ${deepSpaceAgentErrorSummary(error, diagnosticContext)}`,
          )
          void releaseLease()
        },
      }).result
    } catch (error) {
      console.error(
        `[docs-assistant] agent unavailable: ${deepSpaceAgentErrorSummary(error, diagnosticContext)}`,
      )
      await releaseLease()
      return c.json({ error: 'Documentation assistant is not configured' }, 503)
    }

    return result.toUIMessageStreamResponse({
      sendReasoning: false,
      onError: (error) => {
        console.error(
          `[docs-assistant] response error: ${deepSpaceAgentErrorSummary(error, diagnosticContext)}`,
        )
        void releaseLease()
        return 'The documentation assistant could not complete this response.'
      },
    })
  })
}

/** Preserve useful provider diagnostics in Workers-for-Platforms string logs. */
export const docsAssistantErrorSummary = deepSpaceAgentErrorSummary

export interface DocsAssistantHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Accept only the completed, alternating UI turns that precede the current
 * question. The browser remains stateless; the shared agent runner receives a
 * bounded ephemeral transcript on each request.
 */
export function normalizeDocsAssistantHistory(value: unknown): DocsAssistantHistoryMessage[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError('messages must be an array')
  if (value.length > MAX_HISTORY_MESSAGES) {
    throw new TypeError(`messages exceeds ${MAX_HISTORY_MESSAGES} turns`)
  }
  const messages: DocsAssistantHistoryMessage[] = []
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
 * Own the reserved docs namespace before an existing app's SPA wildcard.
 * The dispatcher rewrites public docs requests into this namespace.
 */
export function registerDocsStaticRoutes<Env extends Pick<DocsAssistantRouteEnv, 'ASSETS'>>(
  app: Hono<{ Bindings: Env }>,
): void {
  app.get('/_docs/*', async (c) => {
    const pathname = new URL(c.req.url).pathname
    let response = await c.env.ASSETS.fetch(c.req.raw)
    let status = response.status
    if (status === 404) {
      const url = new URL(c.req.url)
      url.pathname = '/_docs/404.html'
      response = await c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw))
      status = 404
    }
    return secureDocsResponse(response, status, pathname)
  })
}

function secureDocsResponse(response: Response, status: number, pathname: string): Response {
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
