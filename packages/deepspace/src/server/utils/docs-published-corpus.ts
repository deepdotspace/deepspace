import { normalizeDocsRoute, parseDocsCorpus, type DocsCorpusChunk } from './docs-assistant'

export interface DocsPublishedManifest {
  sourceHash: string
  name: string
  assistant: {
    access: 'disabled' | 'public' | 'authenticated'
    model?: string
  }
  mcp: {
    access: 'disabled' | 'public'
  }
}

export interface DocsPublishedEnv {
  ASSETS: Fetcher
}

export interface DocsPublishedPage {
  route: string
  title: string
  markdown: string
}

export type DocsPublishedCorpusResult =
  | { ok: true; chunks: DocsCorpusChunk[] }
  | { ok: false; error: unknown }

let cachedCorpus: { sourceHash: string; chunks: DocsCorpusChunk[] } | undefined

/** Read the small, generated policy manifest shared by docs runtime features. */
export async function loadDocsPublishedManifest(
  env: DocsPublishedEnv,
  requestUrl = 'https://assets.local/',
): Promise<DocsPublishedManifest | null> {
  const response = await env.ASSETS.fetch(new URL('/_docs/manifest.json', requestUrl).toString())
  if (!response.ok) return null
  const value = await response.json().catch(() => null)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const manifest = value as Record<string, unknown>
  const assistant = parseAssistantPolicy(manifest.assistant)
  if (
    typeof manifest.sourceHash !== 'string' ||
    typeof manifest.name !== 'string' ||
    !assistant
  ) return null

  return {
    sourceHash: manifest.sourceHash,
    name: manifest.name,
    assistant,
    // Older docs artifacts did not carry an MCP policy. Fail closed until the
    // docs bundle is rebuilt by an MCP-aware SDK release.
    mcp: parseMcpPolicy(manifest.mcp) ?? { access: 'disabled' },
  }
}

/** Load and validate the generated corpus once per docs source hash. */
export async function loadDocsPublishedCorpus(
  env: DocsPublishedEnv,
  sourceHash: string,
  requestUrl = 'https://assets.local/',
): Promise<DocsCorpusChunk[]> {
  if (cachedCorpus?.sourceHash === sourceHash) return cachedCorpus.chunks
  const response = await env.ASSETS.fetch(
    new URL('/_docs/assistant-index.json', requestUrl).toString(),
  )
  if (!response.ok) throw new Error(`assistant-index.json returned ${response.status}`)
  const chunks = parseDocsCorpus(await response.json())
  cachedCorpus = { sourceHash, chunks }
  return chunks
}

/** Convert asset and validation failures into one explicit route-level result. */
export async function resolveDocsPublishedCorpus(
  env: DocsPublishedEnv,
  sourceHash: string,
  requestUrl = 'https://assets.local/',
): Promise<DocsPublishedCorpusResult> {
  try {
    return { ok: true, chunks: await loadDocsPublishedCorpus(env, sourceHash, requestUrl) }
  } catch (error) {
    return { ok: false, error }
  }
}

/** Read the complete generated Markdown only for a route in the public corpus. */
export async function readDocsPublishedPage(
  env: DocsPublishedEnv,
  corpus: DocsCorpusChunk[],
  requestedRoute: string,
  requestUrl = 'https://assets.local/',
): Promise<DocsPublishedPage | null> {
  const route = normalizeDocsRoute(requestedRoute.split('#', 1)[0] ?? '/')
  const firstChunk = corpus.find((chunk) => chunk.route === route)
  if (!firstChunk) return null

  const pathname = route === '/' ? '/_docs/index.md' : `/_docs${route}.md`
  const response = await env.ASSETS.fetch(new URL(pathname, requestUrl).toString())
  if (!response.ok) return null
  const markdown = await response.text()
  if (markdown.length > 500_000) throw new Error('Documentation page exceeds 500000 characters')
  return { route, title: firstChunk.title, markdown }
}

function parseAssistantPolicy(
  value: unknown,
): DocsPublishedManifest['assistant'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const policy = value as Record<string, unknown>
  if (!['disabled', 'public', 'authenticated'].includes(String(policy.access))) return null
  return {
    access: policy.access as DocsPublishedManifest['assistant']['access'],
    ...(typeof policy.model === 'string' ? { model: policy.model } : {}),
  }
}

function parseMcpPolicy(value: unknown): DocsPublishedManifest['mcp'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const policy = value as Record<string, unknown>
  if (!['disabled', 'public'].includes(String(policy.access))) return null
  return { access: policy.access as DocsPublishedManifest['mcp']['access'] }
}
