/**
 * App-files limits, chunk planning, and failure reading — shared by every
 * caller of the files API: the browser hook (`client/storage/useR2Files.ts`),
 * the CLI (`cli/lib/app-files-api.ts`), the server handler
 * (`server/utils/scoped-r2-files.ts`), and the docs that quote them.
 *
 * There are three numbers here and they answer three different questions.
 * Conflating them is what produced the old 25 MiB per-file ceiling: that was
 * never a product decision, it was the size of one HTTP request leaking out as
 * a rule about files. A request is bounded by physics — Cloudflare rejects an
 * oversized body before any worker runs, and the worker's isolate is ~128 MiB.
 * A FILE is not, once it travels as a sequence of bounded requests.
 *
 * The other half of this module is failure reading. An upload refused at the
 * edge answers with a Cloudflare HTML page, which every caller used to feed
 * straight into `JSON.parse` and report as "Unexpected token '<' … is not
 * valid JSON". `describeFilesFailure` exists to make that impossible.
 */

/**
 * The largest single file the app-files API accepts.
 *
 * Reachable only through the multipart transport: a file above
 * {@link UPLOAD_PART_BYTES} is uploaded as a sequence of parts, so no request
 * and no isolate ever holds more than one part. Enforced by the shared handler
 * (`server/utils/scoped-r2-files.ts`) twice — once at init against the
 * declared total, so an impossible upload fails before a byte moves, and again
 * at complete against the assembled object, because the declared total is
 * client-supplied. Callers check it locally too, but only to fail early;
 * skipping the client check cannot widen what is accepted.
 */
export const MAX_APP_FILE_BYTES = 1024 * 1024 * 1024

/**
 * The most any ONE request body may carry — a whole small file on the
 * single-request path, or one part on the multipart path.
 *
 * This is the transport's real physical bound, and the only thing 25 MiB ever
 * meant. Above it the worker risks exhausting its isolate holding the body;
 * well above it (~100 MB) Cloudflare refuses the request before the worker
 * runs at all, which is why callers must read failures as text first.
 */
export const MAX_UPLOAD_REQUEST_BYTES = 25 * 1024 * 1024

/**
 * The part size clients chunk at, and the threshold above which they must.
 *
 * Below the {@link MAX_UPLOAD_REQUEST_BYTES} bound with headroom for the
 * request envelope, and comfortably inside R2's own part rules: parts must be
 * at least 5 MiB and every non-final part must be exactly the same size
 * (R2 errors 10011 / 10048). The server advertises this at init — a client
 * chunks at the size it is told, not at this constant, so the number can move
 * without stranding older callers mid-upload.
 */
export const UPLOAD_PART_BYTES = 20 * 1024 * 1024

/**
 * The highest part number the server accepts.
 *
 * The handler holds no per-session state, so this — not the declared total —
 * is what bounds an in-flight upload. It is computed against
 * {@link UPLOAD_PART_BYTES}, which is why the server refuses a part larger
 * than that even though a whole small file may be 25 MiB: admitting 25 MiB
 * parts would make the real in-flight bound 52 × 25 MiB = 1300 MiB while the
 * advertised ceiling stayed 1 GiB. With both numbers agreeing, a session's
 * worst case is 52 × 20 MiB = 1040 MiB — the ceiling plus one part.
 *
 * R2 allows 10,000 parts, so this is far inside what the API permits.
 */
export const MAX_UPLOAD_PARTS = Math.ceil(MAX_APP_FILE_BYTES / UPLOAD_PART_BYTES)

/**
 * The largest base64 payload the single-request JSON shape can carry.
 *
 * Derived from the ENCODED size, because that is what the request body is:
 * base64 spends 4 characters per 3 bytes, so a payload measured only by its
 * decoded size can sit under {@link MAX_UPLOAD_REQUEST_BYTES} and still
 * produce a body a third larger than the server will accept — a client check
 * that passes everything the server then refuses. Roughly 18.75 MiB.
 */
export const MAX_BASE64_UPLOAD_BYTES = Math.floor((MAX_UPLOAD_REQUEST_BYTES * 3) / 4)

/** Byte ranges for a chunked upload: `[start, end)`, `end` exclusive. */
export interface UploadPart {
  partNumber: number
  start: number
  end: number
}

/**
 * Split a file into the parts the multipart transport expects.
 *
 * Every part is exactly `partSize` except the last, which is what R2 requires
 * of non-final parts. Both chunking clients plan with this, so "which bytes
 * are part N" is answered in one place.
 */
export function planUploadParts(totalBytes: number, partSize: number): UploadPart[] {
  const parts: UploadPart[] = []
  for (let start = 0; start < totalBytes; start += partSize) {
    parts.push({
      partNumber: parts.length + 1,
      start,
      end: Math.min(start + partSize, totalBytes),
    })
  }
  return parts
}

/**
 * Per-tier storage schedule, in bytes. Product semantics, not a deployment
 * dial — the one table both storage allocations admit against:
 *
 *   - the repo store (Git packs + retained bundles + deploy assets), admitted
 *     by the app's Repo DO (`platform/deploy-worker/src/vc/storage-quota.ts`)
 *   - the app-files allocation, admitted by the shared files handler
 *     (`server/utils/scoped-r2-files.ts`)
 *
 * Each allocation gets the full amount independently; they are different
 * buckets with different writers (docs/platform/r2-storage.md). The
 * customer-visible "storage" number is the app-files allocation — the repo
 * store is platform bookkeeping that degrades (drops rollback retention)
 * rather than surfacing here.
 */
export const APP_STORAGE_LIMIT_BYTES = {
  test: 0,
  free: 128 * 1024 * 1024,
  starter: 512 * 1024 * 1024,
  premium: 2 * 1024 * 1024 * 1024,
  admin: 10 * 1024 * 1024 * 1024,
} as const

/** The storage limit for a billing tier; unknown or missing tiers get free. */
export function storageLimitForTier(tier: string | null | undefined): number {
  if (tier && Object.hasOwn(APP_STORAGE_LIMIT_BYTES, tier)) {
    return APP_STORAGE_LIMIT_BYTES[tier as keyof typeof APP_STORAGE_LIMIT_BYTES]
  }
  return APP_STORAGE_LIMIT_BYTES.free
}

/** The one storage-quota refusal sentence. `usedBytes` is net of any object
 *  the upload replaces, so an upsert is charged only for its growth. */
export function storageQuotaMessage(
  incomingBytes: number,
  usedBytes: number,
  limitBytes: number,
): string {
  const free = Math.max(0, limitBytes - usedBytes)
  return (
    `This upload needs ${formatBytes(incomingBytes)} but the app's file storage has ` +
    `${formatBytes(free)} free (${formatBytes(usedBytes)} of ${formatBytes(limitBytes)} used). ` +
    `Delete files with \`deepspace app files rm <key>\`, or upgrade the owner's plan.`
  )
}

/**
 * The largest single file a deploy may ship as a static asset.
 *
 * Cloudflare Static Assets refuses anything larger, so this is a hard edge of
 * the platform rather than a policy dial — which is why the CLI may check it
 * locally. It lives here so the deploy worker and the CLI cannot drift; the
 * per-DEPLOY total is deliberately NOT here, because it is env-configurable
 * per environment and only the server can know it.
 */
export const MAX_DEPLOY_ASSET_FILE_BYTES = 25 * 1024 * 1024

/**
 * MIME types a browser executes as active web content in the app's origin.
 * Accepting these from end users would allow stored XSS — a victim loading the
 * file URL runs the uploader's HTML/JS/SVG in the app origin and can exfiltrate
 * the app JWT (see client/auth/token.ts).
 *
 * The upload handler is the enforcer; every client checks the same set so the
 * refusal is named before the bytes are sent, and so no caller can quietly
 * relabel one of these as `application/octet-stream` to get it stored.
 */
export const DANGEROUS_MIME_TYPES = new Set<string>([
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

/** The one sentence for a refused-type upload. */
export function activeContentMessage(mimeType: string): string {
  // No "rename it to get past this" — the check exists because the bytes are
  // dangerous in this origin, and a rename changes only the label.
  return (
    `${mimeType} is not accepted: the files API serves your app's own origin, so stored ` +
    `HTML/SVG/JavaScript would execute there with your users' sessions. Ship it as a build ` +
    `asset under \`public/\` instead, where it is served as part of your app rather than as ` +
    `user-uploaded content.`
  )
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`
  return `${bytes} B`
}

/** Encode an R2 key as URL path segments while preserving its hierarchy. */
export function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

/** The one oversize sentence, for whichever caller notices first. */
export function oversizeMessage(bytes: number, limit = MAX_APP_FILE_BYTES): string {
  return `That file is ${formatBytes(bytes)}; the limit is ${formatBytes(limit)} per file.`
}

/**
 * The one over-the-request-bound sentence. Distinct from
 * {@link oversizeMessage} because it names a fixable mistake: the file is fine,
 * the caller just sent it in one piece instead of in parts.
 */
export function oversizeRequestMessage(bytes: number): string {
  return (
    `This request carries ${formatBytes(bytes)}; one request may carry ` +
    `${formatBytes(MAX_UPLOAD_REQUEST_BYTES)}. Files above ` +
    `${formatBytes(UPLOAD_PART_BYTES)} upload in parts.`
  )
}

/** A part is bounded tighter than a request; say which number was crossed. */
export function oversizePartMessage(bytes: number): string {
  return (
    `This part carries ${formatBytes(bytes)}; a part may carry ` +
    `${formatBytes(UPLOAD_PART_BYTES)} — the size the upload advertised.`
  )
}

/**
 * Turn a failed files-API response into a sentence worth showing.
 *
 * `body` is the raw response text. A JSON `{ error }` is the app's own
 * refusal and is passed through; anything else came from the edge (an HTML
 * error page, an empty body, a proxy) and is described by its status instead
 * of being echoed, because echoing it is what produced the JSON-parse noise.
 */
export function describeFilesFailure(status: number, body: string): string {
  const trimmed = body.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: string }
      if (parsed.error) return parsed.error
    } catch {
      // Not the app's JSON after all — fall through to the status description.
    }
  }
  if (status === 413) {
    return (
      `The upload is too large. Files are limited to ${formatBytes(MAX_APP_FILE_BYTES)}, ` +
      `and one request may carry ${formatBytes(MAX_UPLOAD_REQUEST_BYTES)} — a larger request ` +
      `is rejected by the network before the app receives it.`
    )
  }
  if (status === 411) return 'The upload did not declare its length.'
  if (status === 401 || status === 403) return 'Not authorized to write these files.'
  if (status === 415) return 'That file type is not accepted.'
  if (status >= 500) return `The files service failed (HTTP ${status}). Retry shortly.`
  return `Upload failed (HTTP ${status}).`
}
