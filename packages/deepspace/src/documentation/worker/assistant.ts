import { tool, type ToolSet } from 'ai'
import { z } from 'zod/v4'
import { collapseRoute as normalizeDocumentationRoute, documentationPublicPath } from '../routing'

export { normalizeDocumentationRoute }

export interface DocumentationCorpusChunk {
  id: string
  route: string
  title: string
  heading?: string
  text: string
}

export interface DocumentationSearchResult {
  route: string
  title: string
  heading?: string
  excerpt: string
  score: number
}

const MAX_CHUNKS = 10_000
const MAX_CHUNK_CHARS = 2_500
const MAX_CORPUS_CHARS = 12_000_000
const SEARCH_STOP_WORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'are',
  'can',
  'could',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'should',
  'the',
  'this',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'will',
  'with',
  'would',
  'you',
  'your',
])

interface IndexedDocumentationChunk {
  text: string
  textTerms: string[]
  title: string
  titleTerms: Set<string>
}

const indexedChunkCache = new WeakMap<DocumentationCorpusChunk, IndexedDocumentationChunk>()

/** Validate the generated assistant index before any content reaches a model. */
export function parseDocumentationCorpus(value: unknown): DocumentationCorpusChunk[] {
  if (!Array.isArray(value)) throw new Error('Documentation assistant index must be an array')
  if (value.length > MAX_CHUNKS) {
    throw new Error(`Documentation assistant index exceeds ${MAX_CHUNKS} chunks`)
  }
  const chunks: DocumentationCorpusChunk[] = []
  let totalChars = 0
  for (let index = 0; index < value.length; index++) {
    const raw = value[index]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Documentation assistant chunk ${index} must be an object`)
    }
    const chunk = raw as Record<string, unknown>
    if (
      typeof chunk.id !== 'string' ||
      !chunk.id ||
      typeof chunk.route !== 'string' ||
      !chunk.route.startsWith('/') ||
      typeof chunk.title !== 'string' ||
      !chunk.title ||
      typeof chunk.text !== 'string' ||
      !chunk.text
    ) {
      throw new Error(`Documentation assistant chunk ${index} has invalid required fields`)
    }
    if (chunk.text.length > MAX_CHUNK_CHARS) {
      throw new Error(`Documentation assistant chunk ${chunk.id} exceeds ${MAX_CHUNK_CHARS} characters`)
    }
    totalChars += chunk.text.length
    if (totalChars > MAX_CORPUS_CHARS) {
      throw new Error(`Documentation assistant corpus exceeds ${MAX_CORPUS_CHARS} characters`)
    }
    chunks.push({
      id: chunk.id,
      route: chunk.route,
      title: chunk.title,
      ...(typeof chunk.heading === 'string' && chunk.heading ? { heading: chunk.heading } : {}),
      text: chunk.text,
    })
  }
  return chunks
}

/** Deterministic local lexical retrieval used by the documentation agent tools. */
export function searchDocumentationCorpus(
  corpus: DocumentationCorpusChunk[],
  query: string,
  limit = 6,
): DocumentationSearchResult[] {
  const normalized = normalize(query)
  const terms = [
    ...new Set(
      normalized.split(' ').filter((term) => term.length > 1 && !SEARCH_STOP_WORDS.has(term)),
    ),
  ]
  if (!terms.length) return []
  const requiredTerms = new Set(terms)
  return corpus
    .map((chunk) => {
      const { text, textTerms, title, titleTerms } = indexChunk(chunk)
      const textCounts = countTerms(textTerms, requiredTerms)
      let score = 0
      if (title === normalized) score += 120
      else if (title.includes(normalized)) score += 55
      if (text.includes(normalized)) score += 30
      for (const term of terms) {
        if (titleTerms.has(term)) score += 14
        score += Math.min(6, textCounts.get(term) ?? 0) * 3
      }
      const matchedTerms = terms.filter(
        (term) => titleTerms.has(term) || textCounts.has(term),
      ).length
      score += matchedTerms * matchedTerms * 4
      score += proximityBonus([...titleTerms, ...textTerms], terms)
      return {
        route: chunk.route,
        title: chunk.title,
        ...(chunk.heading ? { heading: chunk.heading } : {}),
        excerpt: excerpt(chunk.text, terms),
        score,
      }
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.route.localeCompare(right.route))
    .slice(0, Math.max(1, Math.min(limit, 10)))
}

export function readDocumentationRoute(
  corpus: DocumentationCorpusChunk[],
  route: string,
): Array<Pick<DocumentationCorpusChunk, 'route' | 'title' | 'heading' | 'text'>> {
  const normalizedRoute = normalizeDocumentationRoute(route)
  return corpus
    .filter((chunk) => chunk.route === normalizedRoute)
    .slice(0, 12)
    .map(({ route: chunkRoute, title, heading, text }) => ({
      route: chunkRoute,
      title,
      ...(heading ? { heading } : {}),
      text,
    }))
}

export function buildDocumentationAssistantTools(corpus: DocumentationCorpusChunk[], basePath = '/docs'): ToolSet {
  return {
    documentation_search: tool({
      description:
        'Search the current documentation. Use this before answering factual or how-to questions.',
      inputSchema: z.object({
        query: z.string().trim().min(2).max(300),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      execute: async ({ query, limit }) => ({
        results: searchDocumentationCorpus(corpus, query, limit ?? 6).map((result) => ({
          ...result,
          url: documentationPublicPath(basePath, result.route),
        })),
      }),
    }),
    documentation_read: tool({
      description:
        'Read bounded source chunks for one exact documentation route returned by documentation_search.',
      inputSchema: z.object({ route: z.string().trim().startsWith('/').max(500) }),
      execute: async ({ route }) => ({
        route: normalizeDocumentationRoute(route),
        url: documentationPublicPath(basePath, route),
        chunks: readDocumentationRoute(corpus, route),
      }),
    }),
  }
}

export function buildDocumentationAssistantPrompt(
  appName: string,
  currentRoute: string | undefined,
): string {
  return [
    `You are the public documentation assistant for "${appName}" on DeepSpace.`,
    'Answer only from the documentation available through documentation_search and documentation_read.',
    'Search before answering unless the user is only greeting you.',
    'Use documentation_read when search excerpts are insufficient or ambiguous.',
    'Never claim access to application records, integrations, private data, or mutation tools.',
    'If the documentation does not support an answer, say so plainly and suggest the closest documented page.',
    'Cite factual answers with Markdown links to the exact documentation routes returned by tools.',
    'Do not invent URLs, APIs, configuration keys, versions, or behavior.',
    'Keep answers concise, practical, and explicit about uncertainty.',
    ...(currentRoute
      ? [`The reader is currently viewing ${normalizeDocumentationRoute(currentRoute)}.`]
      : []),
  ].join('\n')
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(canonicalSearchTerm)
    .join(' ')
}

function canonicalSearchTerm(term: string): string {
  if (SEARCH_STOP_WORDS.has(term)) return term
  if (['doc', 'docs', 'document', 'documents', 'documentation'].includes(term)) return 'documentation'
  if (
    ['builds', 'building', 'built', 'compile', 'compiled', 'compiles', 'compiling'].includes(term)
  ) {
    return 'build'
  }
  return term.length > 3 && term.endsWith('s') && !term.endsWith('ss') ? term.slice(0, -1) : term
}

function indexChunk(chunk: DocumentationCorpusChunk): IndexedDocumentationChunk {
  const cached = indexedChunkCache.get(chunk)
  if (cached) return cached
  const title = normalize(`${chunk.title} ${chunk.heading ?? ''}`)
  const text = normalize(chunk.text)
  const indexed = {
    text,
    textTerms: text.split(' '),
    title,
    titleTerms: new Set(title.split(' ')),
  }
  indexedChunkCache.set(chunk, indexed)
  return indexed
}


function countTerms(tokens: string[], required: Set<string>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) {
    if (required.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return counts
}

function proximityBonus(tokens: string[], terms: string[]): number {
  const required = new Set(terms)
  if (required.size < 2) return 0
  const counts = new Map<string, number>()
  let matched = 0
  let start = 0
  let smallestWindow = Number.POSITIVE_INFINITY
  for (let end = 0; end < tokens.length; end++) {
    const token = tokens[end] ?? ''
    if (required.has(token)) {
      const count = counts.get(token) ?? 0
      counts.set(token, count + 1)
      if (count === 0) matched++
    }
    while (matched === required.size && start <= end) {
      smallestWindow = Math.min(smallestWindow, end - start + 1)
      const first = tokens[start] ?? ''
      if (required.has(first)) {
        const count = counts.get(first) ?? 0
        counts.set(first, count - 1)
        if (count === 1) matched--
      }
      start++
    }
  }
  return Number.isFinite(smallestWindow) ? Math.max(0, 42 - smallestWindow * 2) : 0
}

function excerpt(text: string, terms: string[]): string {
  const lower = text.toLowerCase()
  const first =
    terms
      .map((term) => lower.indexOf(term))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? 0
  const start = Math.max(0, first - 160)
  const end = Math.min(text.length, start + 520)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}
