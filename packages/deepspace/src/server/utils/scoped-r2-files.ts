/**
 * Shared Scoped R2 Files Handler
 *
 * Provides a secure, prefix-scoped R2 files API that enforces:
 *   1. All R2 keys are validated against the resolved prefix (no bypass)
 *   2. Path traversal (`..`, `.`) is rejected
 *   3. Mutations (upload/delete) require authentication by default
 *
 * Each worker provides a `resolvePrefix` callback for its scoping rules.
 * The security invariants are enforced here once — not per-worker.
 *
 * Routes:
 *   POST   /api/files/upload  → upload (prefix + generated key)
 *   GET    /api/files          → list   (prefix + optional user prefix)
 *   GET    /api/files/:key     → download (validated against prefix)
 *   DELETE /api/files/:key     → delete   (validated against prefix)
 */

/// <reference types="@cloudflare/workers-types" />

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' } as const

// ============================================================================
// Types
// ============================================================================

export interface ScopeContext {
  userId: string | null
  url: URL
}

export type PrefixResult =
  | { prefix: string; error?: undefined }
  | { prefix?: undefined; error: string }

export interface ScopedR2Config {
  /**
   * Resolve the R2 key prefix for the given scope.
   * Called with the `?scope=` query param value (default: 'self').
   */
  resolvePrefix: (scope: string, ctx: ScopeContext) => PrefixResult

  /**
   * Require a non-null userId for upload and delete.
   * @default true
   */
  requireAuthForMutations?: boolean
}

export interface ScopedR2Auth {
  userId: string | null
}

export type ScopedR2Handler = (
  request: Request,
  url: URL,
  bucket: R2Bucket,
  auth: ScopedR2Auth,
) => Promise<Response>

// ============================================================================
// Path Security
// ============================================================================

/**
 * Build a safe Content-Disposition header value from an uploader-supplied
 * filename. The legacy `filename=` parameter is double-quoted, so a name
 * containing `"` or CR/LF can break out of the value and inject arbitrary
 * response headers (response-splitting). We strip those characters for the
 * legacy parameter and use RFC 5987 `filename*` with percent-encoding for
 * the canonical, UTF-8-safe form that modern browsers prefer.
 */
function contentDisposition(originalName: string): string {
  // The legacy `filename=` value must be ASCII as well as header-safe; Fetch
  // implementations may reject raw Unicode header bytes. `filename*` carries
  // the exact UTF-8 name for modern clients.
  const safe = originalName.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'download'
  // encodeURIComponent leaves five characters that RFC 5987 does not admit
  // in an attr-char value, so escape those too.
  const encoded = encodeURIComponent(originalName).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `inline; filename="${safe}"; filename*=UTF-8''${encoded}`
}

/**
 * Reject path traversal attempts.
 * Returns null if the path contains `..` or `.` segments.
 */
function sanitizeSubpath(raw: string): string | null {
  if (!raw) return ''
  const segments = raw.split('/')
  if (segments.some((s) => s === '..' || s === '.')) return null
  return raw
}

/** Encode an R2 key for use as URL path segments while preserving hierarchy. */
function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

/**
 * Validate that a key falls within the expected prefix.
 *
 * This is the core security check: the resolved prefix is derived from
 * authenticated context (userId, widgetId, appName), so ensuring the
 * requested key starts with the prefix prevents cross-scope access.
 */
function isKeyWithinPrefix(key: string, prefix: string): boolean {
  return key.startsWith(prefix)
}

// ============================================================================
// MIME Security
// ============================================================================

// MIME types the browser will execute as active web content in the app's
// origin. Accepting these from end users would allow stored XSS — a victim
// loading the file URL runs the uploader's HTML/JS/SVG in the app origin
// and can exfiltrate the app JWT (see client/auth/token.ts).
const DANGEROUS_MIME_TYPES = new Set<string>([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
  'application/javascript',
  'text/javascript',
  'application/ecmascript',
  'text/ecmascript',
])

function normalizeMimeType(raw: string): string {
  return raw.split(';')[0].trim().toLowerCase()
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a scoped R2 files handler.
 *
 * Security guarantees:
 *   - Download/delete keys are validated to start with the resolved prefix
 *   - Path traversal (`..`) is rejected at the entry point
 *   - Mutations require a non-null userId by default
 *
 * @returns A handler function: `(request, url, bucket, auth) => Promise<Response>`
 */
export function createScopedR2Handler(config: ScopedR2Config): ScopedR2Handler {
  const requireAuthForMutations = config.requireAuthForMutations ?? true

  return async (request, url, bucket, auth) => {
    // url.pathname preserves percent-encoding (e.g. spaces → %20), but R2
    // keys are stored with raw characters. Decode so the lookup matches.
    let subpathRaw: string
    try {
      subpathRaw = decodeURIComponent(url.pathname.replace('/api/files', '').replace(/^\//, ''))
    } catch {
      return Response.json(
        { error: 'Invalid path encoding' },
        { status: 400, headers: CORS_HEADERS },
      )
    }

    // Sanitize — reject traversal attempts
    const subpath = sanitizeSubpath(subpathRaw)
    if (subpath === null) {
      return Response.json(
        { error: 'Invalid path: traversal not allowed' },
        { status: 400, headers: CORS_HEADERS },
      )
    }

    // Every operation defaults to per-user storage. Public app-scope reads
    // must say `?scope=app`; upload/list responses preserve that selector in
    // their URLs. This is load-bearing because user keys are nested below the
    // app prefix — treating every keyed GET as app scope exposed known private
    // keys anonymously.
    const scope = url.searchParams.get('scope') || 'self'
    if (scope !== 'self' && scope !== 'app') {
      return Response.json({ error: 'Invalid scope' }, { status: 400, headers: CORS_HEADERS })
    }
    const result = config.resolvePrefix(scope, { userId: auth.userId, url })

    if (!result.prefix) {
      const errorMsg = result.error ?? 'Invalid scope'
      const status = errorMsg.toLowerCase().includes('auth') ? 401 : 400
      return Response.json({ error: errorMsg }, { status, headers: CORS_HEADERS })
    }

    const prefix: string = result.prefix

    // ── Upload ──────────────────────────────────────────────────────────
    if (subpath === 'upload' && request.method === 'POST') {
      if (requireAuthForMutations && !auth.userId) {
        return Response.json(
          { error: 'Authentication required' },
          { status: 401, headers: CORS_HEADERS },
        )
      }
      return handleUpload(request, url, bucket, prefix, auth.userId, scope)
    }

    // ── List ────────────────────────────────────────────────────────────
    if (!subpath && request.method === 'GET') {
      return handleList(bucket, prefix, url, scope)
    }

    // ── Download ────────────────────────────────────────────────────────
    if (subpath && request.method === 'GET') {
      if (!isKeyWithinPrefix(subpath, prefix)) {
        return Response.json(
          { error: 'Access denied: key outside scope' },
          { status: 403, headers: CORS_HEADERS },
        )
      }
      return handleDownload(bucket, subpath, scope)
    }

    // ── Delete ──────────────────────────────────────────────────────────
    if (subpath && request.method === 'DELETE') {
      if (requireAuthForMutations && !auth.userId) {
        return Response.json(
          { error: 'Authentication required' },
          { status: 401, headers: CORS_HEADERS },
        )
      }
      if (!isKeyWithinPrefix(subpath, prefix)) {
        return Response.json(
          { error: 'Access denied: key outside scope' },
          { status: 403, headers: CORS_HEADERS },
        )
      }
      await bucket.delete(subpath)
      return Response.json({ success: true, deleted: subpath }, { headers: CORS_HEADERS })
    }

    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: CORS_HEADERS })
  }
}

// ============================================================================
// Operation Handlers
// ============================================================================

async function handleUpload(
  request: Request,
  url: URL,
  bucket: R2Bucket,
  prefix: string,
  userId: string | null,
  scope: string,
): Promise<Response> {
  try {
    const contentType = request.headers.get('content-type') || ''
    let fileData: ArrayBuffer
    let fileName: string
    let mimeType: string

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData()
      const file = formData.get('file') as File | null
      if (!file) {
        return Response.json({ error: 'No file provided' }, { status: 400, headers: CORS_HEADERS })
      }
      fileData = await file.arrayBuffer()
      fileName = formData.get('name')?.toString() || file.name
      mimeType = file.type || 'application/octet-stream'
    } else {
      const body = (await request.json()) as { data: string; name: string; mimeType?: string }
      if (!body.data || !body.name) {
        return Response.json(
          { error: 'Missing data or name' },
          { status: 400, headers: CORS_HEADERS },
        )
      }
      const base64Data = body.data.replace(/^data:[^;]+;base64,/, '')
      fileData = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0)).buffer
      fileName = body.name
      mimeType = body.mimeType || 'application/octet-stream'
    }

    // Reject MIME types that browsers execute as active content. Done at
    // the source (upload) so dangerous content-types never enter R2 — the
    // download handler is then free to trust stored metadata.
    mimeType = normalizeMimeType(mimeType) || 'application/octet-stream'
    if (DANGEROUS_MIME_TYPES.has(mimeType)) {
      return Response.json(
        { error: `Unsupported media type: ${mimeType}` },
        { status: 415, headers: CORS_HEADERS },
      )
    }

    // Deterministic key mode: `?key=<subkey>` overrides the timestamped-
    // filename behavior so callers can upsert at a known location. The
    // subkey is treated as a path under the resolved prefix and is
    // path-traversal-checked (`..` / `.` segments rejected).
    //
    // Without ?key: legacy behavior — generate a unique key per upload so
    // multiple uploads of the same name don't clobber each other.
    const requestedKey = url.searchParams.get('key')
    let key: string
    if (requestedKey !== null) {
      const safe = sanitizeSubpath(requestedKey)
      if (safe === null) {
        return Response.json(
          { error: 'Invalid key: traversal not allowed' },
          { status: 400, headers: CORS_HEADERS },
        )
      }
      if (!safe) {
        return Response.json(
          { error: 'Invalid key: empty' },
          { status: 400, headers: CORS_HEADERS },
        )
      }
      key = `${prefix}${safe}`
    } else {
      const fileKey = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}-${fileName}`
      key = `${prefix}${fileKey}`
    }
    await bucket.put(key, fileData, {
      httpMetadata: { contentType: mimeType },
      customMetadata: {
        originalName: fileName,
        ...(userId ? { uploadedBy: userId } : {}),
        uploadedAt: new Date().toISOString(),
      },
    })

    const fileUrl = new URL(`/api/files/${encodeKeyPath(key)}`, url.origin)
    fileUrl.searchParams.set('scope', scope)
    return Response.json(
      { success: true, key, url: fileUrl.toString(), name: fileName },
      { headers: CORS_HEADERS },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upload failed'
    console.error('[handleUpload] Error:', msg, err instanceof Error ? err.stack : '')
    return Response.json({ error: msg }, { status: 500, headers: CORS_HEADERS })
  }
}

async function handleList(
  bucket: R2Bucket,
  prefix: string,
  url: URL,
  scope: string,
): Promise<Response> {
  const userPrefix = url.searchParams.get('prefix') || ''
  const listPrefix = `${prefix}${userPrefix}`
  const limit = parseInt(url.searchParams.get('limit') || '100', 10)
  const listed = await bucket.list({ prefix: listPrefix, limit })
  const files = listed.objects.map((obj) => {
    const fileUrl = new URL(`/api/files/${encodeKeyPath(obj.key)}`, url.origin)
    fileUrl.searchParams.set('scope', scope)
    return {
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded.toISOString(),
      url: fileUrl.toString(),
      ...obj.customMetadata,
    }
  })
  return Response.json({ files, truncated: listed.truncated }, { headers: CORS_HEADERS })
}

async function handleDownload(
  bucket: R2Bucket,
  key: string,
  scope: 'self' | 'app',
): Promise<Response> {
  const object = await bucket.get(key)
  if (!object) {
    return Response.json({ error: 'File not found' }, { status: 404, headers: CORS_HEADERS })
  }
  const headers = new Headers()
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set(
    'Cache-Control',
    scope === 'app' ? 'public, max-age=31536000, immutable' : 'private, no-store',
  )
  headers.set('Access-Control-Allow-Origin', '*')
  if (object.customMetadata?.originalName) {
    headers.set('Content-Disposition', contentDisposition(object.customMetadata.originalName))
  }
  return new Response(object.body, { headers })
}
