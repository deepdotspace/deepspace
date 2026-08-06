/**
 * App-files limits and failure reading, shared by every caller of the files
 * API: the browser hook (`client/storage/useR2Files.ts`), the CLI
 * (`cli/lib/app-files-api.ts`), and the docs that quote them.
 *
 * The ceiling is not a product decision made here — it is what the transport
 * physically allows. An upload crosses Cloudflare's request-body limit before
 * any worker code runs, and the platform worker then reads the whole body into
 * a ~128 MiB isolate before writing it to R2. So an oversized upload does not
 * fail as a friendly JSON error; it fails as a raw Cloudflare HTML page that
 * every caller here used to feed straight into `JSON.parse` and report as
 * "Unexpected token '<' … is not valid JSON". That is the bug this module
 * exists to make impossible.
 */

/**
 * The largest single file the app-files API accepts.
 *
 * Enforced by the shared upload handler (`server/utils/scoped-r2-files.ts`),
 * which is the only place it is a real limit — above it the platform worker
 * risks exhausting its isolate while holding the decoded file and the
 * multipart envelope together. Callers also check it locally, but only so the
 * failure is named early; skipping the client check cannot widen what is
 * accepted. Well above it (~100 MB) Cloudflare rejects the request before the
 * worker runs at all, which is why callers must read failures as text first.
 */
export const MAX_APP_FILE_BYTES = 25 * 1024 * 1024

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`
  return `${bytes} B`
}

/** Encode an R2 key as URL path segments while preserving its hierarchy. */
export function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

/** The one oversize sentence, for whichever caller notices first. */
export function oversizeMessage(bytes: number): string {
  return `That file is ${formatBytes(bytes)}; the limit is ${formatBytes(MAX_APP_FILE_BYTES)} per file.`
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
      `The file is too large to upload. The limit is ` +
      `${formatBytes(MAX_APP_FILE_BYTES)} per file; larger uploads are rejected by the ` +
      `network before the app receives them.`
    )
  }
  if (status === 401 || status === 403) return 'Not authorized to write these files.'
  if (status === 415) return 'That file type is not accepted.'
  if (status >= 500) return `The files service failed (HTTP ${status}). Retry shortly.`
  return `Upload failed (HTTP ${status}).`
}
