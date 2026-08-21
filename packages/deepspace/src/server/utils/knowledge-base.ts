import { appendAppIdentity, type AppIdentityEnv } from './app-identity'
import { apiWorkerFetch, type ApiWorkerEnv } from './proxies'

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-(javascript|typescript)))/iu
/** Matches the API worker's bound; a search reads a query, not a document. */
const MAX_QUERY_CHARS = 4096

/** NUL, CR/LF and friends: these reach the provider as a multipart filename.
 *  Checked by codepoint rather than a regex literal, which cannot embed
 *  control characters without tripping `no-control-regex`. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}
export interface KnowledgeEnv extends ApiWorkerEnv, AppIdentityEnv {}
export type KnowledgeStatus = 'queued' | 'running' | 'completed' | 'error' | 'skipped' | 'outdated'
export interface KnowledgeItem {
  id: string
  key: string
  status: KnowledgeStatus
  fileSize?: number
  chunksCount?: number
  createdAt?: string
  updatedAt?: string
  error?: string
}
export interface KnowledgeAddOptions {
  folder?: string
}
export interface KnowledgeListOptions {
  folder?: string
  page?: number
  perPage?: number
  status?: KnowledgeStatus
  search?: string
}
export interface KnowledgeSearchOptions {
  folder?: string
  mode?: 'hybrid' | 'semantic' | 'fulltext'
  limit?: number
  matchThreshold?: number
  queryRewrite?: boolean
}
export interface KnowledgeAddResult {
  items: KnowledgeItem[]
}
export interface KnowledgeListResult {
  items: KnowledgeItem[]
  page: number
  perPage: number
  total?: number
  totalPages?: number
}
export interface KnowledgeSearchChunk {
  id: string
  score: number
  text: string
  key?: string
  filename?: string
  folder?: string
  timestamp?: string
}
export interface KnowledgeSearchResult {
  chunks: KnowledgeSearchChunk[]
  queryKind?: string
}
export interface ScopedKnowledgeClient {
  add(file: File): Promise<KnowledgeAddResult>
  list(options?: Omit<KnowledgeListOptions, 'folder'>): Promise<KnowledgeListResult>
  search(
    query: string,
    options?: Omit<KnowledgeSearchOptions, 'folder'>,
  ): Promise<KnowledgeSearchResult>
}
export interface KnowledgeClient extends ScopedKnowledgeClient {
  add(file: File, options?: KnowledgeAddOptions): Promise<KnowledgeAddResult>
  list(options?: KnowledgeListOptions): Promise<KnowledgeListResult>
  remove(itemId: string): Promise<void>
  search(query: string, options?: KnowledgeSearchOptions): Promise<KnowledgeSearchResult>
  scoped(scope: { folder: string }): ScopedKnowledgeClient
}

export class KnowledgeError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly uploadedItems?: KnowledgeItem[],
  ) {
    super(message)
    this.name = 'KnowledgeError'
  }
}

export function normalizeKnowledgeFolder(folder: string): string {
  if (!folder || folder.includes('\\') || hasControlChar(folder) || folder.startsWith('/'))
    throw new KnowledgeError(400, 'invalid_folder', 'Folder must be a relative forward-slash path')
  // Accept the normalized form too. This keeps scoped clients idempotent:
  // they capture `docs/` once and can safely pass it through the same
  // validation used by root-client calls.
  const withoutTrailingSlash = folder.endsWith('/') ? folder.slice(0, -1) : folder
  if (!withoutTrailingSlash || withoutTrailingSlash.endsWith('/'))
    throw new KnowledgeError(400, 'invalid_folder', 'Folder cannot contain empty segments')
  const parts = withoutTrailingSlash.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new KnowledgeError(
      400,
      'invalid_folder',
      'Folder cannot contain empty, dot, or parent segments',
    )
  const normalized = `${parts.join('/')}/`
  if (normalized.length > 128)
    throw new KnowledgeError(400, 'invalid_folder', 'Folder is too long for an AI Search item key')
  return normalized
}

function validateKnowledgeFilename(name: string): void {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    hasControlChar(name)
  ) {
    throw new KnowledgeError(
      400,
      'invalid_filename',
      'File name must be a non-empty base name without path separators',
    )
  }
}

export function folderFilter(folder: string): { folder: { $gte: string; $lt: string } } {
  const value = normalizeKnowledgeFolder(folder)
  // `/` is immediately followed by `0` in the provider's lexical ordering.
  return { folder: { $gte: value, $lt: `${value.slice(0, -1)}0` } }
}

export function knowledge(env: KnowledgeEnv): KnowledgeClient {
  const add = (file: File, options: KnowledgeAddOptions = {}) => addFile(env, file, options)
  const list = (options: KnowledgeListOptions = {}) => listItems(env, options)
  const search = (query: string, options: KnowledgeSearchOptions = {}) =>
    searchItems(env, query, options)
  return {
    add,
    list,
    search,
    async remove(itemId) {
      if (!/^[A-Za-z0-9_-]{1,256}$/u.test(itemId))
        throw new KnowledgeError(400, 'invalid_item_id', 'Invalid knowledge item id')
      await request(env, `/api/knowledge/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' })
    },
    scoped({ folder }) {
      const fixed = normalizeKnowledgeFolder(folder)
      return {
        add: (file) => add(file, { folder: fixed }),
        list: (options = {}) => list({ ...options, folder: fixed }),
        search: (query, options = {}) => search(query, { ...options, folder: fixed }),
      }
    },
  }
}

async function addFile(
  env: KnowledgeEnv,
  file: File,
  options: KnowledgeAddOptions,
): Promise<KnowledgeAddResult> {
  validateKnowledgeFilename(file.name)
  const folder = options.folder === undefined ? undefined : normalizeKnowledgeFolder(options.folder)
  if ((folder?.length ?? 0) + file.name.length > 128)
    throw new KnowledgeError(
      400,
      'invalid_key',
      'Folder and filename together exceed the 128-character AI Search key limit',
    )
  if (file.size <= MAX_UPLOAD_BYTES) return upload(env, file, folder)
  if (
    !TEXT_MIME.test(file.type) &&
    !/\.(txt|md|mdx|csv|json|xml|html?|ya?ml|tsx?|jsx?|css)$/iu.test(file.name)
  )
    throw new KnowledgeError(
      413,
      'file_too_large',
      'This file exceeds 4 MB. Split the source document with a format-aware tool before uploading.',
    )
  const bytes = new Uint8Array(await file.arrayBuffer())
  const parts = splitUtf8(bytes, MAX_UPLOAD_BYTES)
  const uploaded: KnowledgeItem[] = []
  try {
    for (let i = 0; i < parts.length; i++) {
      const bytes = parts[i]
      const contents = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer
      const part = new File([contents], partName(file.name, i + 1), {
        type: file.type || 'text/plain',
      })
      if ((folder?.length ?? 0) + part.name.length > 128)
        throw new KnowledgeError(
          400,
          'invalid_key',
          'Folder and split filename together exceed the 128-character AI Search key limit',
        )
      uploaded.push(...(await upload(env, part, folder)).items)
    }
  } catch (error) {
    if (error instanceof KnowledgeError)
      throw new KnowledgeError(error.status, error.code, error.message, uploaded)
    throw new KnowledgeError(502, 'knowledge_upload_failed', 'Knowledge upload failed', uploaded)
  }
  return { items: uploaded }
}

function splitUtf8(bytes: Uint8Array, max: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let start = 0; start < bytes.length; ) {
    let end = Math.min(start + max, bytes.length)
    if (end < bytes.length) {
      let cut = end
      while (cut > start && (bytes[cut] & 0xc0) === 0x80) cut--
      // Start at the final byte already inside this part. Looking at `cut`
      // would inspect the first byte of the next part and could grow this one
      // past the provider's hard limit when that byte is a newline.
      for (let i = cut - 1; i > Math.max(start, cut - 8192); i--)
        if (bytes[i] === 10 && (i === start || bytes[i - 1] === 10)) {
          cut = i + 1
          break
        }
      end = cut > start ? cut : end
    }
    out.push(bytes.slice(start, end))
    start = end
  }
  return out
}
function partName(name: string, n: number): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)}.part-${n}${name.slice(dot)}` : `${name}.part-${n}`
}
async function upload(env: KnowledgeEnv, file: File, folder?: string): Promise<KnowledgeAddResult> {
  const body = new FormData()
  body.append('file', file)
  if (folder) body.append('folder', folder)
  return (await request(env, '/api/knowledge/items', {
    method: 'POST',
    body,
  })) as KnowledgeAddResult
}
async function listItems(
  env: KnowledgeEnv,
  options: KnowledgeListOptions,
): Promise<KnowledgeListResult> {
  if (options.page !== undefined && (!Number.isInteger(options.page) || options.page < 1))
    throw new KnowledgeError(400, 'invalid_page', 'List page must be a positive integer')
  if (
    options.perPage !== undefined &&
    (!Number.isInteger(options.perPage) || options.perPage < 1 || options.perPage > 50)
  )
    throw new KnowledgeError(
      400,
      'invalid_per_page',
      'List perPage must be an integer from 1 to 50',
    )
  if (options.search !== undefined && options.search.length > 256)
    throw new KnowledgeError(400, 'invalid_search', 'List search cannot exceed 256 characters')
  if (
    options.status !== undefined &&
    !['queued', 'running', 'completed', 'error', 'skipped', 'outdated'].includes(options.status)
  )
    throw new KnowledgeError(400, 'invalid_status', 'Invalid knowledge item status')
  const q = new URLSearchParams()
  if (options.folder) q.set('folder', normalizeKnowledgeFolder(options.folder))
  if (options.page !== undefined) q.set('page', String(options.page))
  if (options.perPage !== undefined) q.set('perPage', String(options.perPage))
  if (options.status) q.set('status', options.status)
  if (options.search) q.set('search', options.search)
  return (await request(env, `/api/knowledge/items${q.size ? `?${q}` : ''}`)) as KnowledgeListResult
}
async function searchItems(
  env: KnowledgeEnv,
  query: string,
  options: KnowledgeSearchOptions,
): Promise<KnowledgeSearchResult> {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) throw new KnowledgeError(400, 'invalid_query', 'Search query is required')
  if (normalizedQuery.length > MAX_QUERY_CHARS)
    throw new KnowledgeError(
      400,
      'invalid_query',
      `Search query cannot exceed ${MAX_QUERY_CHARS} characters`,
    )
  if (
    options.mode !== undefined &&
    options.mode !== 'hybrid' &&
    options.mode !== 'semantic' &&
    options.mode !== 'fulltext'
  )
    throw new KnowledgeError(400, 'invalid_mode', 'Invalid knowledge search mode')
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50)
  )
    throw new KnowledgeError(
      400,
      'invalid_limit',
      'Search limit must be an integer from 1 through 50',
    )
  if (
    options.matchThreshold !== undefined &&
    (!Number.isFinite(options.matchThreshold) ||
      options.matchThreshold < 0 ||
      options.matchThreshold > 1)
  )
    throw new KnowledgeError(
      400,
      'invalid_match_threshold',
      'Match threshold must be between 0 and 1',
    )
  if (options.queryRewrite !== undefined && typeof options.queryRewrite !== 'boolean')
    throw new KnowledgeError(
      400,
      'invalid_query_rewrite',
      'queryRewrite must be a boolean when provided',
    )
  const folder = options.folder === undefined ? undefined : normalizeKnowledgeFolder(options.folder)
  return (await request(env, '/api/knowledge/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: normalizedQuery,
      mode: options.mode ?? 'hybrid',
      limit: options.limit ?? 10,
      queryRewrite: options.queryRewrite ?? false,
      ...(options.matchThreshold !== undefined && {
        matchThreshold: options.matchThreshold,
      }),
      ...(folder && { folder }),
    }),
  })) as KnowledgeSearchResult
}
async function request(env: KnowledgeEnv, path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers)
  appendAppIdentity(headers, env)
  const response = await apiWorkerFetch(env, path, { ...init, headers })
  const text = await response.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  if (!response.ok) {
    const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
    throw new KnowledgeError(
      response.status,
      typeof body.code === 'string' ? body.code : 'knowledge_request_failed',
      typeof body.error === 'string' ? body.error : 'Knowledge request failed',
    )
  }
  return data
}
