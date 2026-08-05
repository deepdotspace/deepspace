import {
  normalizeDocumentationRoute,
  parseDocumentationCorpus,
  type DocumentationCorpusChunk,
} from './assistant'
import { DOCUMENTATION_MANIFEST_VERSION } from '../types'
import { canonicalNativeDocumentationRequestPath } from '../resource-path'

export interface DocumentationPublishedManifest {
  sourceHash: string
  name: string
  routes: readonly string[]
  resources: readonly string[]
  assistant: {
    access: 'disabled' | 'public' | 'authenticated'
    model?: string
  }
  mcp: {
    access: 'disabled' | 'public'
  }
}

export interface DocumentationPublishedEnv {
  ASSETS: Fetcher
}

export interface DocumentationPublishedPage {
  route: string
  title: string
  markdown: string
}

export type DocumentationPublishedCorpusResult =
  | { ok: true; chunks: DocumentationCorpusChunk[] }
  | { ok: false; error: unknown }

let cachedCorpus: { sourceHash: string; chunks: DocumentationCorpusChunk[] } | undefined

/** Read the small, generated policy manifest shared by documentation runtime features. */
export async function loadDocumentationPublishedManifest(
  env: DocumentationPublishedEnv,
  requestUrl = 'https://assets.local/',
  assetBasePath = '/_documentation',
): Promise<DocumentationPublishedManifest | null> {
  const response = await env.ASSETS.fetch(
    new Request(new URL(`${assetBasePath}/manifest.json`, requestUrl)),
  )
  if (!response.ok) return null
  const value = await response.json().catch(() => null)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const manifest = value as Record<string, unknown>
  const assistant = parseAssistantPolicy(manifest.assistant)
  const mcp = parseMcpPolicy(manifest.mcp)
  const routes = parsePublishedRoutes(manifest.routes)
  const resources = parsePublishedPaths(manifest.resources, true)
  if (
    manifest.version !== DOCUMENTATION_MANIFEST_VERSION ||
    typeof manifest.sourceHash !== 'string' ||
    typeof manifest.name !== 'string' ||
    !assistant ||
    !mcp ||
    !routes ||
    !resources
  )
    return null

  return {
    sourceHash: manifest.sourceHash,
    name: manifest.name,
    routes,
    resources,
    assistant,
    mcp,
  }
}

function parsePublishedRoutes(value: unknown): string[] | null {
  return parsePublishedPaths(value, false)
}

function parsePublishedPaths(value: unknown, allowEmpty: boolean): string[] | null {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return null
  if (value.some((path) => typeof path !== 'string' || !path.startsWith('/'))) return null
  if (value.some((path) => canonicalNativeDocumentationRequestPath(path as string) !== path))
    return null
  return [...new Set(value)]
}

/** Load and validate the generated corpus once per documentation source hash. */
export async function loadDocumentationPublishedCorpus(
  env: DocumentationPublishedEnv,
  sourceHash: string,
  requestUrl = 'https://assets.local/',
  assetBasePath = '/_documentation',
): Promise<DocumentationCorpusChunk[]> {
  if (cachedCorpus?.sourceHash === sourceHash) return cachedCorpus.chunks
  const response = await env.ASSETS.fetch(
    new Request(new URL(`${assetBasePath}/assistant-index.json`, requestUrl)),
  )
  if (!response.ok) throw new Error(`assistant-index.json returned ${response.status}`)
  const chunks = parseDocumentationCorpus(await response.json())
  cachedCorpus = { sourceHash, chunks }
  return chunks
}

/** Convert asset and validation failures into one explicit route-level result. */
export async function resolveDocumentationPublishedCorpus(
  env: DocumentationPublishedEnv,
  sourceHash: string,
  requestUrl = 'https://assets.local/',
  assetBasePath = '/_documentation',
): Promise<DocumentationPublishedCorpusResult> {
  try {
    return {
      ok: true,
      chunks: await loadDocumentationPublishedCorpus(env, sourceHash, requestUrl, assetBasePath),
    }
  } catch (error) {
    return { ok: false, error }
  }
}

/** Read the complete generated Markdown only for a route in the public corpus. */
export async function readDocumentationPublishedPage(
  env: DocumentationPublishedEnv,
  corpus: DocumentationCorpusChunk[],
  requestedRoute: string,
  requestUrl = 'https://assets.local/',
  assetBasePath = '/_documentation',
): Promise<DocumentationPublishedPage | null> {
  const route = normalizeDocumentationRoute(requestedRoute.split('#', 1)[0] ?? '/')
  const firstChunk = corpus.find((chunk) => chunk.route === route)
  if (!firstChunk) return null

  const pathname = route === '/' ? `${assetBasePath}/index.md` : `${assetBasePath}${route}.md`
  const response = await env.ASSETS.fetch(new Request(new URL(pathname, requestUrl)))
  if (!response.ok) return null
  const markdown = await response.text()
  if (markdown.length > 500_000) throw new Error('Documentation page exceeds 500000 characters')
  return { route, title: firstChunk.title, markdown }
}

function parseAssistantPolicy(value: unknown): DocumentationPublishedManifest['assistant'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const policy = value as Record<string, unknown>
  if (!['disabled', 'public', 'authenticated'].includes(String(policy.access))) return null
  return {
    access: policy.access as DocumentationPublishedManifest['assistant']['access'],
    ...(typeof policy.model === 'string' ? { model: policy.model } : {}),
  }
}

function parseMcpPolicy(value: unknown): DocumentationPublishedManifest['mcp'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const policy = value as Record<string, unknown>
  if (!['disabled', 'public'].includes(String(policy.access))) return null
  return { access: policy.access as DocumentationPublishedManifest['mcp']['access'] }
}
