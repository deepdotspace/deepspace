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
 *   POST   /api/files/upload              → upload one file in one request
 *   POST   /api/files/multipart           → begin a chunked upload
 *   PUT    /api/files/multipart/part      → send one part
 *   POST   /api/files/multipart/complete  → assemble the parts
 *   DELETE /api/files/multipart           → abandon a chunked upload
 *   GET    /api/files                     → list   (prefix + optional user prefix)
 *   GET    /api/files/:key                → download (validated against prefix)
 *   DELETE /api/files/:key                → delete   (validated against prefix)
 *
 * ## One transport discipline
 *
 * Both upload paths obey the rule the deploy asset transport established
 * (`docs/platform/deploy-asset-transport.md`): nothing here
 * ever holds more than one bounded request in memory. The single-request path
 * exists so a small file still costs one round trip; above
 * {@link UPLOAD_PART_BYTES} a file travels as parts, each streamed into R2
 * through a `FixedLengthStream` with a required `Content-Length`. That is why
 * a 1 GiB file is admissible in a ~128 MiB isolate.
 *
 * Validation is identical on both paths and on both mounts, because it lives
 * here: the prefix scoping, the traversal check, the MIME refusals, and both
 * size bounds. A hand-rolled request that skips every client guard reaches
 * exactly these checks.
 */

/// <reference types="@cloudflare/workers-types" />

import {
  ACCOUNT_STORAGE_LIMIT_BYTES,
  DANGEROUS_MIME_TYPES,
  MAX_APP_FILE_BYTES,
  MAX_DEPLOY_ASSET_FILE_BYTES,
  MAX_UPLOAD_PARTS,
  MAX_UPLOAD_REQUEST_BYTES,
  UPLOAD_PART_BYTES,
  encodeKeyPath,
  formatBytes,
  oversizeMessage,
  oversizePartMessage,
  oversizeRequestMessage,
  storageLimitForTier,
  storageQuotaMessage,
} from '../../shared/app-files'
import {
  activateMultipartReservation,
  admitStorage,
  markQuotaDirty,
  multipartMarkerKey,
  quotaUnavailable,
  readMultipartReservation,
  refreshMultipartReservation,
  releaseQuotaMarker,
  storageUsage,
} from './r2-storage-quota'
import type { MultipartQuotaReservation, StorageAdmission } from './r2-storage-quota'

export type { StorageAdmission } from './r2-storage-quota'

// The limits this handler enforces, re-exported so workers and their tests
// cite the constants rather than copies of the numbers — two copies of one
// limit is how the CLI and the workers drift. `formatBytes` rides along for
// the same reason.
export {
  ACCOUNT_STORAGE_LIMIT_BYTES,
  MAX_APP_FILE_BYTES,
  MAX_DEPLOY_ASSET_FILE_BYTES,
  MAX_UPLOAD_REQUEST_BYTES,
  UPLOAD_PART_BYTES,
  MAX_UPLOAD_PARTS,
  formatBytes,
  storageLimitForTier,
  storageQuotaMessage,
}

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' } as const

/** Every refusal in this file, in one shape. */
function fail(
  status: number,
  error: string,
  code?: string,
  extra?: Record<string, unknown>,
): Response {
  return Response.json(
    { error, ...(code ? { code } : {}), ...extra },
    { status, headers: CORS_HEADERS },
  )
}

// ============================================================================
// Types
// ============================================================================

export interface ScopeContext {
  userId: string | null
  url: URL
}

export type PrefixResult =
  | { prefix: string; excludedPrefixes?: readonly string[]; error?: undefined }
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

/**
 * The storage-quota contract for one allocation, supplied per request by the
 * mount. The handler is the enforcer; the mount only knows whose limit
 * applies.
 */
export interface ScopedR2Auth {
  userId: string | null
  /** Absent = no quota on this mount (e.g. an app's own bucket). */
  storage?: StorageAdmission
  /** Account-wide quota details are private to an authorized owner surface. */
  includeStorageUsage?: boolean
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
function contentDisposition(originalName: string, disposition: 'inline' | 'attachment'): string {
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
  return `${disposition}; filename="${safe}"; filename*=UTF-8''${encoded}`
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

/**
 * Refuse a request body past {@link MAX_UPLOAD_REQUEST_BYTES}.
 *
 * This is where the transport's physical bound is real. Clients check it too,
 * but only to fail early — a hand-rolled request that skips them reaches here,
 * and without this the worker would buffer the whole body into a ~128 MiB
 * isolate. Callers check Content-Length BEFORE reading the body, then the
 * decoded size, which catches a body that lied about (or omitted) its length.
 * The 8 KiB slack leaves room for multipart headers around a maximum body.
 */
function overRequestBound(bytes: number, slack = 0): Response | null {
  if (bytes <= MAX_UPLOAD_REQUEST_BYTES + slack) return null
  return fail(413, oversizeRequestMessage(bytes), 'too_large', {
    maxBytes: MAX_UPLOAD_REQUEST_BYTES,
    partSize: UPLOAD_PART_BYTES,
  })
}

/** Refuse a FILE past {@link MAX_APP_FILE_BYTES} — the product ceiling. */
function overCeiling(bytes: number): Response | null {
  if (bytes <= MAX_APP_FILE_BYTES) return null
  return fail(413, oversizeMessage(bytes), 'too_large', { maxBytes: MAX_APP_FILE_BYTES })
}

/**
 * Refuse a part past {@link UPLOAD_PART_BYTES}.
 *
 * Tighter than the request bound on purpose. Parts must be uniform, so a
 * client sending a bigger one has ignored what init told it — and this is the
 * number {@link MAX_UPLOAD_PARTS} is computed against, so admitting a larger
 * part would silently raise the real ceiling above the advertised one.
 */
function overPartBound(bytes: number): Response | null {
  if (bytes <= UPLOAD_PART_BYTES) return null
  return fail(413, oversizePartMessage(bytes), 'too_large', { maxBytes: UPLOAD_PART_BYTES })
}

/**
 * The length a request declares, or the refusal for one that declares none.
 *
 * `Number(null)` is 0, so reading the header without testing for its ABSENCE
 * treats a chunked body as an empty one — and it then passes every size bound
 * before anything has been read. That is not theoretical: a chunked control
 * body sailed past the 64 KiB cap into an unbounded `request.json()`, and a
 * chunked part reached `FixedLengthStream(0)` and failed as "declared 0 bytes
 * but its body did not carry them", blaming the client for the server's own
 * missing check. One helper, so both paths ask the question the same way.
 */
function declaredLength(request: Request, what: string): number | Response {
  const raw = request.headers.get('content-length')
  const declared = raw === null ? NaN : Number(raw)
  if (!Number.isSafeInteger(declared) || declared < 0) {
    return fail(
      411,
      `${what} must declare a Content-Length. A chunked or length-less body is refused: ` +
        `R2 cannot size a write it has no length for.`,
      'length_required',
    )
  }
  return declared
}

/**
 * Validate that a key falls within the expected prefix.
 *
 * This is the core security check: the resolved prefix is derived from
 * authenticated context (userId, widgetId, appName), so ensuring the
 * requested key starts with the prefix prevents cross-scope access.
 */
function isKeyWithinScope(
  key: string,
  prefix: string,
  excludedPrefixes: readonly string[],
): boolean {
  return key.startsWith(prefix) && !excludedPrefixes.some((excluded) => key.startsWith(excluded))
}

/**
 * The key a caller can address within its own scope: the stored key minus the
 * resolved prefix. Clients never learn the prefix (it is derived from their
 * authenticated context), so every response that names an absolute key also
 * carries this spelling — the one that works with `list(prefix)` filters and
 * `?key=` upserts. The inverse of {@link anchorKey}, and the only place the
 * slice happens.
 */
function scopeRelativeKey(key: string, prefix: string): string {
  return key.slice(prefix.length)
}

/**
 * Anchor a caller-supplied key under the resolved prefix.
 *
 * The one place a client gets to name a location. Used by the single-request
 * upsert (`?key=`) and by every multipart call (`?uploadKey=`), so a key can
 * never address another scope on either path — and a stolen `uploadId` is
 * inert, because the key it must be resumed with is rebuilt from the caller's
 * own authenticated prefix.
 */
function anchorKey(
  raw: string,
  prefix: string,
  excludedPrefixes: readonly string[],
): { key: string } | Response {
  const safe = sanitizeSubpath(raw)
  if (safe === null) return fail(400, 'Invalid key: traversal not allowed', 'invalid_key')
  if (!safe) return fail(400, 'Invalid key: empty', 'invalid_key')
  const key = `${prefix}${safe}`
  return isKeyWithinScope(key, prefix, excludedPrefixes)
    ? { key }
    : fail(403, 'Access denied: key belongs to a private scope', 'forbidden')
}

/**
 * The handler's own verbs: subpaths that name an operation rather than a key.
 *
 * Exported because the owner mount has to know them. That mount anchors a
 * caller's key under the app's prefix before dispatching here, and a verb must
 * arrive un-prefixed — so both sides read this one table and cannot drift.
 */
const VERB_ROUTES = new Set([
  'POST upload',
  'POST multipart',
  'DELETE multipart',
  'PUT multipart/part',
  'POST multipart/complete',
])

export function isFilesVerbPath(method: string, subpath: string): boolean {
  return VERB_ROUTES.has(`${method} ${subpath}`)
}

// ============================================================================
// MIME Security
// ============================================================================

// The refused set lives in shared/app-files.ts so the CLI and the browser
// hook check the same list before sending; this handler stays the enforcer.
/**
 * Normalize the stored media type. Active content is valid downloadable data;
 * the download boundary forces it to an attachment so it cannot execute in
 * the app's origin.
 */
function resolveMimeType(raw: string): string {
  const mimeType = raw.split(';')[0].trim().toLowerCase() || 'application/octet-stream'
  return mimeType
}

/**
 * R2 names its refusals with a numeric code at the end of the message
 * (`"uploadPart: The specified multipart upload does not exist. (10024)"`).
 * Reading it is what lets a client be told which mistake it made instead of
 * being handed a 500.
 */
function r2ErrorCode(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error)
  const match = /\((\d{4,6})\)\s*$/.exec(message.trim())
  return match ? Number(match[1]) : null
}

/**
 * Turn an R2 multipart failure into an honest status and sentence.
 *
 * The codes are R2's documented ones (`r2/api/error-codes`). Note that the
 * local emulator is not faithful for every one of them — it answers 10001
 * ("internal error") where production R2 answers 10024 on `complete` for an
 * unknown session — so this maps what R2 documents, and the tests assert
 * against the operations the emulator does reproduce.
 */
function multipartFailure(error: unknown): Response {
  switch (r2ErrorCode(error)) {
    case 10024: // NoSuchUpload
      return fail(
        404,
        'That upload does not exist — it was completed, abandoned, or expired. Start a new one.',
        'unknown_upload',
      )
    case 10011: // EntityTooSmall
    case 10025: // InvalidPart — a named part was never uploaded
    case 10048: // InvalidPart — non-final parts must all be the same size
      return fail(
        400,
        'The parts do not assemble: every part except the last must be exactly the size the ' +
          'upload advertised, and each must be uploaded before it is named.',
        'bad_parts',
      )
    case 10012: // MetadataTooLarge
    case 10020: // InvalidObjectName
      return fail(400, 'The upload names a key or metadata R2 will not accept.', 'invalid_key')
    default: {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[files:multipart] R2 error:', message)
      return fail(
        503,
        'The files service could not complete that upload. Retry shortly.',
        'r2_error',
      )
    }
  }
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
    const excludedPrefixes = result.excludedPrefixes ?? []

    // ── Upload: one request, or a chunked session ───────────────────────
    if (isFilesVerbPath(request.method, subpath)) {
      if (requireAuthForMutations && !auth.userId) {
        // Nothing past this point reads the body, so tell the client rather
        // than leaving the runtime to tear the connection down mid-upload.
        await request.body?.cancel().catch(() => undefined)
        return fail(401, 'Authentication required', 'unauthorized')
      }
      return subpath === 'upload'
        ? handleUpload(request, url, bucket, prefix, excludedPrefixes, auth, scope)
        : handleMultipart(request, url, bucket, prefix, excludedPrefixes, auth, scope, subpath)
    }

    // ── List ────────────────────────────────────────────────────────────
    if (!subpath && request.method === 'GET') {
      return handleList(bucket, prefix, excludedPrefixes, url, scope, auth)
    }

    // ── Download ────────────────────────────────────────────────────────
    if (subpath && request.method === 'GET') {
      if (!isKeyWithinScope(subpath, prefix, excludedPrefixes)) {
        return Response.json(
          { error: 'Access denied: key outside scope' },
          { status: 403, headers: CORS_HEADERS },
        )
      }
      return handleDownload(request, bucket, subpath, scope)
    }

    // ── Delete ──────────────────────────────────────────────────────────
    if (subpath && request.method === 'DELETE') {
      if (requireAuthForMutations && !auth.userId) {
        return Response.json(
          { error: 'Authentication required' },
          { status: 401, headers: CORS_HEADERS },
        )
      }
      if (!isKeyWithinScope(subpath, prefix, excludedPrefixes)) {
        return Response.json(
          { error: 'Access denied: key outside scope' },
          { status: 403, headers: CORS_HEADERS },
        )
      }
      // R2 deletes are idempotent, so a typo'd key used to report exactly what
      // a real one did. Report which happened — but keep the 200: this is a
      // shipped API and deployed apps branch on `res.ok`, so turning an
      // idempotent DELETE into a 404 would break them. `deleted` carries the
      // fact; the CLI is where it becomes a visible refusal.
      const existed = (await bucket.head(subpath)) !== null
      if (existed) {
        await bucket.delete(subpath)
        // The high-water summary never decrements speculatively. Marking it
        // reclaimable lets the next would-be refusal repair immediately.
        await markQuotaDirty(bucket, auth.storage)
      }
      return Response.json(
        { success: true, deleted: existed ? subpath : null, existed },
        { headers: CORS_HEADERS },
      )
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
  excludedPrefixes: readonly string[],
  auth: ScopedR2Auth,
  scope: string,
): Promise<Response> {
  try {
    // Before anything reads the body.
    const declaredBytes = declaredLength(request, 'File uploads')
    if (declaredBytes instanceof Response) return declaredBytes
    const tooLargeRequest = overRequestBound(declaredBytes, 8 * 1024)
    if (tooLargeRequest) return tooLargeRequest

    const contentType = request.headers.get('content-type') || ''
    let fileData: ArrayBuffer
    let fileName: string
    let rawMimeType: string

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData()
      const file = formData.get('file') as File | null
      if (!file) return fail(400, 'No file provided', 'bad_request')
      const tooBig = overRequestBound(file.size)
      if (tooBig) return tooBig
      fileData = await file.arrayBuffer()
      fileName = formData.get('name')?.toString() || file.name
      rawMimeType = file.type || 'application/octet-stream'
    } else {
      const body = (await request.json()) as { data: string; name: string; mimeType?: string }
      if (!body.data || !body.name) return fail(400, 'Missing data or name', 'bad_request')
      const base64Data = body.data.replace(/^data:[^;]+;base64,/, '')
      // Check the DECODED size before allocating it: base64 carries 3 bytes
      // per 4 characters, so a body inside the Content-Length guard can still
      // decode past the bound.
      const tooBig = overRequestBound(Math.floor((base64Data.length * 3) / 4))
      if (tooBig) return tooBig
      fileData = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0)).buffer
      fileName = body.name
      rawMimeType = body.mimeType || 'application/octet-stream'
    }

    const mimeType = resolveMimeType(rawMimeType)

    const located = locateUpload(url, prefix, excludedPrefixes, fileName)
    if (located instanceof Response) return located

    // Only an explicit `?key=` can replace something; generated keys are fresh.
    const replacesKey = url.searchParams.get('key') === null ? null : located.key
    const replaced = replacesKey === null ? null : await bucket.head(replacesKey)
    const replacedBytes = replaced?.size ?? 0
    const admission = await admitStorage(bucket, auth.storage, fileData.byteLength, replacedBytes)
    if (admission instanceof Response) return admission

    try {
      const written = await bucket.put(located.key, fileData, {
        // Replacement credit is valid only while the exact object that earned
        // it still exists. A concurrent delete or overwrite loses this CAS and
        // retries from a fresh head instead of landing uncounted bytes.
        ...(replaced ? { onlyIf: { etagMatches: replaced.etag } } : {}),
        httpMetadata: { contentType: mimeType },
        customMetadata: fileMetadata(fileName, auth.userId),
      })
      if (!written) {
        await releaseQuotaMarker(bucket, auth.storage, admission.markerKey, true)
        return fail(
          409,
          'The file changed while this upload was being admitted. Retry the upload.',
          'write_conflict',
        )
      }
    } catch (error) {
      await releaseQuotaMarker(bucket, auth.storage, admission.markerKey, true)
      throw error
    }
    await releaseQuotaMarker(
      bucket,
      auth.storage,
      admission.markerKey,
      admission.markerKey !== null || fileData.byteLength < replacedBytes,
    )
    return storedFileJson(located.key, prefix, fileName, url, scope)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upload failed'
    console.error('[handleUpload] Error:', msg, err instanceof Error ? err.stack : '')
    return fail(500, msg, 'upload_failed')
  }
}

/**
 * Where an upload lands.
 *
 * Deterministic key mode: `?key=<subkey>` overrides the timestamped-filename
 * behavior so callers can upsert at a known location. Without it a unique key
 * is generated per upload, so two uploads of the same name don't clobber each
 * other. Both paths use it, so "which key" is decided once.
 */
function locateUpload(
  url: URL,
  prefix: string,
  excludedPrefixes: readonly string[],
  fileName: string,
  generatedId?: string,
): { key: string; subkey: string } | Response {
  const requested = url.searchParams.get('key')
  const subkey =
    requested ??
    (generatedId
      ? `${generatedId}-${fileName}`
      : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}-${fileName}`)
  const anchored = anchorKey(subkey, prefix, excludedPrefixes)
  return anchored instanceof Response ? anchored : { key: anchored.key, subkey }
}

function fileMetadata(
  fileName: string,
  userId: string | null,
  reservationId?: string,
  declaredBytes?: number,
): Record<string, string> {
  return {
    originalName: fileName,
    ...(userId ? { uploadedBy: userId } : {}),
    ...(reservationId ? { reservationId } : {}),
    ...(declaredBytes === undefined ? {} : { declaredBytes: String(declaredBytes) }),
    uploadedAt: new Date().toISOString(),
  }
}

/** The one success shape for a stored file, whichever path stored it. */
function storedFileJson(
  key: string,
  prefix: string,
  name: string,
  url: URL,
  scope: string,
): Response {
  const fileUrl = new URL(`/api/files/${encodeKeyPath(key)}`, url.origin)
  fileUrl.searchParams.set('scope', scope)
  return Response.json(
    {
      success: true,
      key,
      relativeKey: scopeRelativeKey(key, prefix),
      url: fileUrl.toString(),
      name,
    },
    { headers: CORS_HEADERS },
  )
}

// ============================================================================
// Multipart: the transport for anything above one request
// ============================================================================

/** Control bodies are metadata. 52 parts serialize to ~3 KiB. */
const MAX_CONTROL_BODY_BYTES = 64 * 1024

/**
 * Read a small JSON control body.
 *
 * A `Content-Length` is required: every real client sends one for a JSON body,
 * and without it there is nothing to bound the read against before it happens.
 */
async function readControlJson(request: Request): Promise<Record<string, unknown> | Response> {
  const declared = declaredLength(request, 'This request')
  if (declared instanceof Response) return declared
  if (declared > MAX_CONTROL_BODY_BYTES) {
    return fail(413, `Request body exceeds ${MAX_CONTROL_BODY_BYTES} bytes`, 'too_large')
  }
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return fail(400, 'Body must be JSON', 'bad_request')
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : fail(400, 'Body must be a JSON object', 'bad_request')
}

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,80}$/

interface MultipartSessionRef {
  key: string
  uploadKey: string
  uploadId: string
  reservationId: string
}

/** Resolve the session a part/complete/abort call names. */
function resolveSession(
  url: URL,
  prefix: string,
  excludedPrefixes: readonly string[],
): MultipartSessionRef | Response {
  const uploadKey = url.searchParams.get('uploadKey')
  const uploadId = url.searchParams.get('uploadId')
  const reservationId = url.searchParams.get('reservationId')
  if (!uploadKey || !uploadId || !reservationId) {
    return fail(400, 'uploadKey, uploadId, and reservationId are required', 'bad_request')
  }
  if (!REQUEST_ID_RE.test(reservationId)) {
    return fail(400, 'reservationId is invalid', 'bad_request')
  }
  const anchored = anchorKey(uploadKey, prefix, excludedPrefixes)
  return anchored instanceof Response
    ? anchored
    : { key: anchored.key, uploadKey, uploadId, reservationId }
}

function reservationMatches(
  reservation: MultipartQuotaReservation,
  session: MultipartSessionRef,
): boolean {
  return (
    reservation.admitted &&
    reservation.uploadId === session.uploadId &&
    reservation.objectKey === session.key &&
    reservation.uploadKey === session.uploadKey
  )
}

function multipartSessionJson(
  uploadId: string,
  uploadKey: string,
  reservationId: string,
): Response {
  return Response.json(
    {
      uploadId,
      uploadKey,
      reservationId,
      partSize: UPLOAD_PART_BYTES,
      maxParts: MAX_UPLOAD_PARTS,
      maxBytes: MAX_APP_FILE_BYTES,
    },
    { headers: CORS_HEADERS },
  )
}

function multipartPartCount(declaredBytes: number): number {
  return Math.ceil(declaredBytes / UPLOAD_PART_BYTES)
}

function expectedMultipartPartBytes(declaredBytes: number, partNumber: number): number | null {
  const partCount = multipartPartCount(declaredBytes)
  if (partNumber < 1 || partNumber > partCount) return null
  return partNumber === partCount
    ? declaredBytes - (partCount - 1) * UPLOAD_PART_BYTES
    : UPLOAD_PART_BYTES
}

function multipartLayoutError(declaredBytes: number): Response {
  return fail(
    400,
    `This upload must use ${multipartPartCount(declaredBytes)} sequential part(s) at the advertised ${formatBytes(UPLOAD_PART_BYTES)} size, except for the final remainder.`,
    'bad_part_layout',
    { partSize: UPLOAD_PART_BYTES, partCount: multipartPartCount(declaredBytes) },
  )
}

/**
 * Stream one part into R2, exactly as the deploy asset transport streams an
 * object: the declared length travels with the bytes through a
 * `FixedLengthStream`, so a truncated or overlong body fails the write instead
 * of landing a part that lies about its size. Only one chunk is ever resident.
 */
async function streamPart(
  upload: R2MultipartUpload,
  partNumber: number,
  body: ReadableStream<Uint8Array>,
  expectedBytes: number,
): Promise<
  { ok: true; part: R2UploadedPart } | { ok: false; lengthMismatch: boolean; error: unknown }
> {
  let observedBytes = 0
  const sized = new FixedLengthStream(expectedBytes)
  const pumped = body
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          observedBytes += chunk.byteLength
          controller.enqueue(chunk)
        },
      }),
    )
    .pipeTo(sized.writable)

  const [uploaded, drained] = await Promise.allSettled([
    upload.uploadPart(partNumber, sized.readable),
    pumped,
  ])
  if (uploaded.status === 'rejected' || drained.status === 'rejected') {
    const reason =
      uploaded.status === 'rejected' ? uploaded.reason : (drained as PromiseRejectedResult).reason
    return { ok: false, lengthMismatch: observedBytes !== expectedBytes, error: reason }
  }
  return { ok: true, part: uploaded.value }
}

async function handleMultipart(
  request: Request,
  url: URL,
  bucket: R2Bucket,
  prefix: string,
  excludedPrefixes: readonly string[],
  auth: ScopedR2Auth,
  scope: string,
  subpath: string,
): Promise<Response> {
  if (subpath === 'multipart' && request.method === 'POST') {
    return multipartInit(request, url, bucket, prefix, excludedPrefixes, auth)
  }
  if (subpath === 'multipart/part') {
    return multipartPart(request, url, bucket, prefix, excludedPrefixes, auth)
  }
  if (subpath === 'multipart/complete') {
    return multipartComplete(request, url, bucket, prefix, excludedPrefixes, auth, scope)
  }
  return multipartAbort(url, bucket, prefix, excludedPrefixes, auth)
}

/**
 * Begin a chunked upload.
 *
 * Everything checkable is checked here, before a byte of content moves: the
 * declared total against the ceiling, the media type, and the key. The reply
 * carries the part size the client must chunk at — R2 requires every non-final
 * part to be exactly the same size, so the server owning that number is what
 * keeps a client from assembling an upload R2 will refuse.
 */
async function multipartInit(
  request: Request,
  url: URL,
  bucket: R2Bucket,
  prefix: string,
  excludedPrefixes: readonly string[],
  auth: ScopedR2Auth,
): Promise<Response> {
  const body = await readControlJson(request)
  if (body instanceof Response) return body

  const size = body.size
  if (!Number.isSafeInteger(size) || (size as number) <= 0) {
    return fail(400, 'size must be a positive integer number of bytes', 'bad_request')
  }
  const tooBig = overCeiling(size as number)
  if (tooBig) return tooBig

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return fail(400, 'name is required', 'bad_request')
  const requestId = typeof body.requestId === 'string' ? body.requestId : ''
  if (!REQUEST_ID_RE.test(requestId)) {
    return fail(
      400,
      'requestId must be 16–80 URL-safe characters and must be reused when retrying init.',
      'bad_request',
    )
  }

  const mimeType = resolveMimeType(typeof body.mimeType === 'string' ? body.mimeType : '')

  // A caller-generated request id makes the server-generated key stable across
  // an init retry whose first response was lost.
  const located = locateUpload(url, prefix, excludedPrefixes, name, requestId)
  if (located instanceof Response) return located

  // A completed request id is terminal. Reusing it could make a failed
  // completion of a new R2 session look like the old object's successful
  // completion, stranding the new parts without their reservation.
  const completed = await bucket.head(located.key)
  if (completed?.customMetadata?.reservationId === requestId) {
    return fail(
      409,
      'requestId already completed an upload; start the new upload with a fresh requestId.',
      'request_id_completed',
    )
  }

  const existing = await readMultipartReservation(bucket, auth.storage, requestId)
  if (existing === 'invalid') {
    return quotaUnavailable('This upload reservation could not be read. Retry shortly.')
  }
  if (existing) {
    const sameRequest =
      existing.objectKey === located.key &&
      existing.uploadKey === located.subkey &&
      existing.declaredBytes === size
    return sameRequest && existing.admitted
      ? multipartSessionJson(existing.uploadId, existing.uploadKey, requestId)
      : sameRequest
        ? quotaUnavailable('This upload is still being initialized. Retry shortly.')
        : fail(
            409,
            'requestId already belongs to a different multipart upload.',
            'request_id_conflict',
          )
  }

  let upload: R2MultipartUpload
  try {
    upload = await bucket.createMultipartUpload(located.key, {
      httpMetadata: { contentType: mimeType },
      customMetadata: fileMetadata(name, auth.userId, requestId, size as number),
    })
  } catch (error) {
    return multipartFailure(error)
  }

  const marker = auth.storage
    ? {
        key: multipartMarkerKey(auth.storage, requestId),
        body: JSON.stringify({
          version: 1,
          reservationId: requestId,
          uploadId: upload.uploadId,
          objectKey: located.key,
          uploadKey: located.subkey,
          admitted: false,
          declaredBytes: size,
        }),
        metadata: {
          quotaKind: 'multipart',
          active: 'false',
        },
      }
    : undefined
  // Small multipart calls remain part of the plain HTTP contract. Charge at
  // least one R2 minimum part so one-byte sessions cannot create an unbounded
  // number of week-long uploads inside a byte quota.
  const reservedBytes = Math.max(size as number, 5 * 1024 * 1024)
  const admission = await admitStorage(bucket, auth.storage, reservedBytes, 0, marker)
  if (admission instanceof Response) {
    await upload.abort().catch(() => undefined)
    if (admission.status === 409 && auth.storage) {
      const winner = await readMultipartReservation(bucket, auth.storage, requestId)
      if (
        winner &&
        winner !== 'invalid' &&
        winner.objectKey === located.key &&
        winner.uploadKey === located.subkey &&
        winner.declaredBytes === size &&
        winner.admitted
      ) {
        return multipartSessionJson(winner.uploadId, winner.uploadKey, requestId)
      }
    }
    return admission
  }
  if (auth.storage && !(await activateMultipartReservation(bucket, auth.storage, requestId))) {
    await upload.abort().catch(() => undefined)
    await releaseQuotaMarker(bucket, auth.storage, admission.markerKey, true)
    return quotaUnavailable('This upload reservation could not be finalized. Retry shortly.')
  }
  return multipartSessionJson(upload.uploadId, located.subkey, requestId)
}

async function abandonMultipart(
  bucket: R2Bucket,
  session: MultipartSessionRef,
  auth: ScopedR2Auth,
  reservation: MultipartQuotaReservation | null,
): Promise<'aborted' | 'absent' | 'failed'> {
  let result: 'aborted' | 'absent' = 'aborted'
  try {
    await bucket.resumeMultipartUpload(session.key, session.uploadId).abort()
  } catch (error) {
    if (r2ErrorCode(error) !== 10024) {
      console.error('[files:multipart] abort:', error instanceof Error ? error.message : error)
      return 'failed'
    }
    result = 'absent'
  }
  if (reservation) {
    if (!(await releaseQuotaMarker(bucket, auth.storage, reservation.key, true))) return 'failed'
  }
  return result
}

/** Send one part. The body is streamed; it is never held whole. */
async function multipartPart(
  request: Request,
  url: URL,
  bucket: R2Bucket,
  prefix: string,
  excludedPrefixes: readonly string[],
  auth: ScopedR2Auth,
): Promise<Response> {
  const refuse = async (response: Response): Promise<Response> => {
    await request.body?.cancel().catch(() => undefined)
    return response
  }

  const declaredBytes = declaredLength(request, 'Part uploads')
  if (declaredBytes instanceof Response) return refuse(declaredBytes)
  const tooBig = overPartBound(declaredBytes)
  if (tooBig) return refuse(tooBig)

  const partNumber = Number(url.searchParams.get('partNumber'))
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > MAX_UPLOAD_PARTS) {
    return refuse(
      fail(400, `partNumber must be a whole number from 1 to ${MAX_UPLOAD_PARTS}`, 'bad_request'),
    )
  }

  const session = resolveSession(url, prefix, excludedPrefixes)
  if (session instanceof Response) return refuse(session)
  if (!request.body) return fail(400, 'A part body is required', 'bad_request')

  const reservation = await readMultipartReservation(bucket, auth.storage, session.reservationId)
  if (reservation === 'invalid') {
    return refuse(quotaUnavailable('This upload reservation could not be read. Retry shortly.'))
  }
  if (auth.storage && reservation && !reservationMatches(reservation, session)) {
    return refuse(
      fail(
        404,
        'That upload does not exist — it was completed, abandoned, or expired. Start a new one.',
        'unknown_upload',
      ),
    )
  }
  if (auth.storage && !reservation) {
    return refuse(
      fail(
        404,
        'That upload does not exist — it was completed, abandoned, or expired. Start a new one.',
        'unknown_upload',
      ),
    )
  }

  if (reservation) {
    const expectedBytes = expectedMultipartPartBytes(reservation.declaredBytes, partNumber)
    if (expectedBytes === null || declaredBytes !== expectedBytes) {
      return refuse(multipartLayoutError(reservation.declaredBytes))
    }
  }

  // Refresh the session lease before R2 accepts the stream. The declared total
  // determines every valid part number and length, so no per-part ledger is
  // needed: retries are identical by construction.
  const refreshed = await refreshMultipartReservation(
    bucket,
    auth.storage,
    session.reservationId,
    session.uploadId,
    session.key,
  )
  if (auth.storage && (refreshed === null || refreshed === 'invalid')) {
    return refuse(quotaUnavailable('This upload reservation is missing or invalid.'))
  }
  if (refreshed === 'busy') {
    return refuse(quotaUnavailable('This upload reservation is busy. Retry the part shortly.'))
  }

  const upload = bucket.resumeMultipartUpload(session.key, session.uploadId)
  const stored = await streamPart(upload, partNumber, request.body, declaredBytes)
  if (!stored.ok) {
    if (r2ErrorCode(stored.error) === 10024 && reservation) {
      await releaseQuotaMarker(bucket, auth.storage, reservation.key, true)
    }
    return stored.lengthMismatch
      ? fail(
          400,
          `Part ${partNumber} declared ${declaredBytes} bytes but its body did not carry them`,
          'bad_request',
        )
      : multipartFailure(stored.error)
  }
  return Response.json(
    { partNumber: stored.part.partNumber, etag: stored.part.etag },
    { headers: CORS_HEADERS },
  )
}

async function completedReservationObject(
  bucket: R2Bucket,
  session: MultipartSessionRef,
): Promise<R2Object | null> {
  const object = await bucket.head(session.key)
  return object?.customMetadata?.reservationId === session.reservationId ? object : null
}

async function finishCompletedMultipart(
  bucket: R2Bucket,
  session: MultipartSessionRef,
  reservation: MultipartQuotaReservation | null,
  object: R2Object,
  auth: ScopedR2Auth,
  url: URL,
  scope: string,
  prefix: string,
): Promise<Response> {
  const declaredMetadata = Number(object.customMetadata?.declaredBytes)
  const declaredBytes =
    reservation?.declaredBytes ??
    (Number.isSafeInteger(declaredMetadata) && declaredMetadata >= 0
      ? declaredMetadata
      : MAX_APP_FILE_BYTES)
  const refusal =
    overCeiling(object.size) ??
    (object.size > declaredBytes
      ? fail(
          400,
          `The assembled upload exceeded its declared ${declaredBytes}-byte size and was not kept.`,
          'declared_size_exceeded',
        )
      : null)
  if (refusal) {
    let remaining: R2Object | null
    try {
      const current = await bucket.head(session.key)
      if (current?.etag === object.etag) await bucket.delete(session.key)
      remaining = await bucket.head(session.key)
    } catch (error) {
      console.error('[files:multipart] invalid object cleanup:', error)
      return quotaUnavailable('The invalid assembled file could not be removed. Retry completion.')
    }
    if (remaining?.etag === object.etag) {
      return quotaUnavailable('The invalid assembled file could not be removed. Retry completion.')
    }
    if (reservation) {
      const cleaned = await releaseQuotaMarker(bucket, auth.storage, reservation.key, true)
      if (!cleaned) return quotaUnavailable('The upload was removed, but cleanup must be retried.')
    }
    return refusal
  }
  if (reservation) {
    const cleaned = await releaseQuotaMarker(bucket, auth.storage, reservation.key, true)
    if (!cleaned) {
      return quotaUnavailable('The file was stored, but its reservation cleanup must be retried.')
    }
  }
  const name = object.customMetadata?.originalName ?? session.uploadKey.split('/').pop() ?? 'file'
  return storedFileJson(session.key, prefix, name, url, scope)
}

/**
 * Assemble the parts. Completion is idempotent: if R2 committed the object but
 * the response or marker cleanup was interrupted, a retry recognizes the
 * reservation id stored on the object and finishes cleanup.
 */
async function multipartComplete(
  request: Request,
  url: URL,
  bucket: R2Bucket,
  prefix: string,
  excludedPrefixes: readonly string[],
  auth: ScopedR2Auth,
  scope: string,
): Promise<Response> {
  const body = await readControlJson(request)
  if (body instanceof Response) return body
  const session = resolveSession(url, prefix, excludedPrefixes)
  if (session instanceof Response) return session

  const reservation = await readMultipartReservation(bucket, auth.storage, session.reservationId)
  if (reservation === 'invalid') {
    return quotaUnavailable('This upload reservation could not be read. Retry shortly.')
  }
  if (auth.storage && reservation && !reservationMatches(reservation, session)) {
    return fail(
      404,
      'That upload does not exist — it was completed, abandoned, or expired. Start a new one.',
      'unknown_upload',
    )
  }
  if (auth.storage && !reservation) {
    const completed = await completedReservationObject(bucket, session)
    if (completed) {
      return finishCompletedMultipart(bucket, session, null, completed, auth, url, scope, prefix)
    }
    await abandonMultipart(bucket, session, auth, null)
    return quotaUnavailable('This upload reservation is missing or does not match.')
  }

  const raw = body.parts
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail(400, 'parts must be a non-empty array', 'bad_request')
  }
  if (raw.length > MAX_UPLOAD_PARTS) {
    return fail(400, `An upload may have at most ${MAX_UPLOAD_PARTS} parts`, 'bad_request')
  }
  if (reservation && raw.length !== multipartPartCount(reservation.declaredBytes)) {
    return multipartLayoutError(reservation.declaredBytes)
  }
  const parts: R2UploadedPart[] = []
  for (let index = 0; index < raw.length; index++) {
    const { partNumber, etag } = (raw[index] ?? {}) as Record<string, unknown>
    if (
      !Number.isSafeInteger(partNumber) ||
      (partNumber as number) < 1 ||
      (partNumber as number) > MAX_UPLOAD_PARTS
    ) {
      return fail(
        400,
        `parts[${index}].partNumber must be a whole number from 1 to ${MAX_UPLOAD_PARTS}`,
        'bad_request',
      )
    }
    if (reservation && partNumber !== index + 1) {
      return multipartLayoutError(reservation.declaredBytes)
    }
    if (typeof etag !== 'string' || !etag) {
      return fail(400, `parts[${index}].etag must be the string uploadPart returned`, 'bad_request')
    }
    parts.push({ partNumber: partNumber as number, etag })
  }

  let object: R2Object
  try {
    object = await bucket.resumeMultipartUpload(session.key, session.uploadId).complete(parts)
  } catch (error) {
    const completed = await completedReservationObject(bucket, session)
    if (completed) {
      return finishCompletedMultipart(
        bucket,
        session,
        reservation,
        completed,
        auth,
        url,
        scope,
        prefix,
      )
    }
    if (r2ErrorCode(error) === 10024 && reservation) {
      await releaseQuotaMarker(bucket, auth.storage, reservation.key, true)
    }
    return multipartFailure(error)
  }

  return finishCompletedMultipart(bucket, session, reservation, object, auth, url, scope, prefix)
}

/**
 * Abandon a chunked upload, releasing whatever parts landed.
 *
 * Unconditionally idempotent. The postcondition a caller needs is "this
 * session is not holding anything of mine", and a session R2 cannot find is
 * already in that state; one it cannot reach is reaped within 7 days anyway
 * (uncompleted uploads expire). There is no action a caller would take on a
 * failed abort that differs from what it does on a successful one — both
 * clients call this on the failure path and then re-raise the real error.
 * `NoSuchUpload` is already the desired postcondition and still releases the
 * quota marker.
 */
async function multipartAbort(
  url: URL,
  bucket: R2Bucket,
  prefix: string,
  excludedPrefixes: readonly string[],
  auth: ScopedR2Auth,
): Promise<Response> {
  const session = resolveSession(url, prefix, excludedPrefixes)
  if (session instanceof Response) return session
  const reservation = await readMultipartReservation(bucket, auth.storage, session.reservationId)
  if (reservation === 'invalid') {
    return Response.json({ success: true, aborted: false }, { headers: CORS_HEADERS })
  }
  if (auth.storage && reservation && !reservationMatches(reservation, session)) {
    return Response.json({ success: true, aborted: false }, { headers: CORS_HEADERS })
  }
  const result = await abandonMultipart(bucket, session, auth, reservation || null)
  return Response.json({ success: true, aborted: result === 'aborted' }, { headers: CORS_HEADERS })
}

async function handleList(
  bucket: R2Bucket,
  prefix: string,
  excludedPrefixes: readonly string[],
  url: URL,
  scope: string,
  auth: ScopedR2Auth,
): Promise<Response> {
  const userPrefix = url.searchParams.get('prefix') || ''
  const listPrefix = `${prefix}${userPrefix}`
  const requestedLimit = Number(url.searchParams.get('limit') ?? 100)
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.min(1000, Math.max(1, requestedLimit))
    : 100
  const requestCursor = url.searchParams.get('cursor')
  if (excludedPrefixes.some((excluded) => listPrefix.startsWith(excluded))) {
    return Response.json({ files: [], truncated: false }, { headers: CORS_HEADERS })
  }

  // The default workers-types entry intentionally models the oldest runtime,
  // while every DeepSpace worker uses a post-2022 compatibility date where R2
  // honors `include`. Keep that compatibility boundary local to these calls.
  const withMetadata = (options: R2ListOptions) =>
    ({ ...options, include: ['customMetadata'] }) as R2ListOptions & {
      include: ['customMetadata']
    }
  const listed = await bucket.list(
    withMetadata({
      prefix: listPrefix,
      limit,
      ...(requestCursor ? { cursor: requestCursor } : {}),
    }),
  )
  const visible = listed.objects.filter((object) =>
    isKeyWithinScope(object.key, prefix, excludedPrefixes),
  )
  const seen = new Set(visible.map((object) => object.key))
  // The frontier is whichever list call the response's truncation state
  // comes from — the initial page, or the last jump past an excluded
  // subtree below.
  let frontier: R2Objects = listed
  // If a private subtree occupied the first page, jump past it instead of
  // walking private keys or hiding public keys that sort after it. Only a
  // truncated listing has anything left to jump to: from an exhausted page the
  // jump would rewind to keys earlier cursor pages already returned.
  // The frontier advances across iterations: a second excluded subtree must
  // jump from where the previous jump ended, not from the original page's
  // tail — restarting from the stale tail would rewind startAfter and
  // re-return keys an earlier jump already delivered.
  let frontierKey = listed.objects.at(-1)?.key
  for (const excluded of excludedPrefixes
    .filter((candidate) => candidate.startsWith(listPrefix))
    .sort()) {
    if (!frontier.truncated || visible.length >= limit) break
    const excludedEnd = `${excluded}\u{10ffff}`
    const after = await bucket.list(
      withMetadata({
        prefix: listPrefix,
        startAfter: frontierKey && frontierKey > excludedEnd ? frontierKey : excludedEnd,
        limit: limit - visible.length,
      }),
    )
    for (const object of after.objects) {
      if (!seen.has(object.key) && isKeyWithinScope(object.key, prefix, excludedPrefixes)) {
        seen.add(object.key)
        visible.push(object)
      }
    }
    frontierKey = after.objects.at(-1)?.key ?? frontierKey
    frontier = after
  }
  const files = visible.slice(0, limit).map((obj) => {
    const fileUrl = new URL(`/api/files/${encodeKeyPath(obj.key)}`, url.origin)
    fileUrl.searchParams.set('scope', scope)
    return {
      key: obj.key,
      relativeKey: scopeRelativeKey(obj.key, prefix),
      size: obj.size,
      uploaded: obj.uploaded.toISOString(),
      url: fileUrl.toString(),
      ...obj.customMetadata,
    }
  })
  // Account totals belong only on the explicitly authorized owner surface.
  // Public app listings do no registry, billing, or quota-repair work.
  let storage: { usedBytes: number; limitBytes?: number } | undefined
  if (auth.storage && auth.includeStorageUsage) {
    const usedBytes = await storageUsage(bucket, auth.storage)
    if (usedBytes !== null) storage = { usedBytes }
    const limitBytes = await auth.storage.limitBytes()
    if (storage && limitBytes !== null) storage.limitBytes = limitBytes
  }
  // The cursor rides with `truncated`: it continues the frontier list call,
  // so `?cursor=` resumes exactly there.
  return Response.json(
    {
      files,
      truncated: frontier.truncated,
      ...(frontier.truncated ? { cursor: frontier.cursor } : {}),
      ...(storage ? { storage } : {}),
    },
    { headers: CORS_HEADERS },
  )
}

async function handleDownload(
  request: Request,
  bucket: R2Bucket,
  key: string,
  scope: 'self' | 'app',
): Promise<Response> {
  const object = await bucket.get(key)
  if (!object) {
    return Response.json({ error: 'File not found' }, { status: 404, headers: CORS_HEADERS })
  }
  const headers = new Headers()
  const storedType = resolveMimeType(object.httpMetadata?.contentType ?? '')
  const mustDownload = DANGEROUS_MIME_TYPES.has(storedType)
  headers.set('Content-Type', mustDownload ? 'application/octet-stream' : storedType)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('ETag', object.httpEtag)
  headers.set(
    'Cache-Control',
    scope === 'self' ? 'private, no-store' : 'public, max-age=0, must-revalidate',
  )
  headers.set('Access-Control-Allow-Origin', '*')
  const originalName = object.customMetadata?.originalName ?? key.split('/').pop() ?? 'download'
  headers.set(
    'Content-Disposition',
    contentDisposition(originalName, mustDownload ? 'attachment' : 'inline'),
  )
  if (mustDownload) headers.set('Content-Security-Policy', "sandbox; default-src 'none'")
  if (scope === 'app' && request.headers.get('if-none-match') === object.httpEtag) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(object.body, { headers })
}
