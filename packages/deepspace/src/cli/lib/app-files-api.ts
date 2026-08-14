/**
 * Transport for the owner app-files surface (`deepspace app files`).
 *
 * All four verbs go through {@link request}: one place that attaches the
 * bearer, names the right environment variable when the platform is
 * unreachable, and maps a non-2xx onto {@link ApiError}. `apiFetch` is not
 * used here — it hardcodes `Content-Type: application/json`, buffers the
 * response, and reports failures against `DEEPSPACE_DEPLOY_URL`, which is a
 * different service from the one these calls go to.
 */

import { createWriteStream, openAsBlob, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { ApiError } from './api'
import {
  MAX_APP_FILE_BYTES,
  UPLOAD_PART_BYTES,
  describeFilesFailure,
  encodeKeyPath,
  formatBytes,
  oversizeMessage,
  planUploadParts,
} from '../../shared/app-files'

export { MAX_APP_FILE_BYTES, UPLOAD_PART_BYTES, encodeKeyPath, formatBytes }

export interface AppFileEntry {
  key: string
  size: number
  uploaded: string
  originalName?: string
}

/**
 * Extensions worth naming explicitly. Anything unlisted uploads as
 * `application/octet-stream`, which stores and serves fine — the type only
 * decides the Content-Type a browser later sees.
 *
 * Active-content extensions are named accurately too. The files service stores
 * them as ordinary data and forces them to download rather than execute in the
 * app's origin.
 *
 * `.xml` is deliberately not inferred because the extension covers many data
 * formats; callers that care about its exact media type can use the HTTP API.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.zip': 'application/zip',
}

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export function filesPath(appId: string, rest = ''): string {
  return `/api/app-files/${appId}${rest}`
}

/**
 * One authenticated call against the platform worker.
 *
 * A failed response is NOT assumed to be JSON: past the edge's request limit
 * Cloudflare answers with an HTML page before any worker runs, and echoing it
 * is how an oversized upload surfaced as `Unexpected token '<'` instead of a
 * size limit. `describeFilesFailure` decides what is worth showing.
 */
async function request(
  baseUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    })
  } catch (err) {
    throw new ApiError(
      `Could not reach the DeepSpace platform at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Check your connection (and DEEPSPACE_PLATFORM_URL), then retry.`,
      0,
      'network_error',
      path,
    )
  }
  if (res.ok) return res
  const text = await res.text()
  let code: string | undefined
  let details: Record<string, unknown> | undefined
  try {
    const body = JSON.parse(text.trim()) as Record<string, unknown>
    code = typeof body.code === 'string' ? body.code : undefined
    // Everything the server quantified travels with the refusal — a storage
    // refusal's usedBytes/limitBytes reach `--json` as numbers instead of
    // being left for the caller to parse back out of the sentence.
    const rest = Object.fromEntries(
      Object.entries(body).filter(([key]) => key !== 'error' && key !== 'code'),
    )
    if (Object.keys(rest).length > 0) details = rest
  } catch {
    // Not the app's JSON; the status carries the meaning.
  }
  throw new ApiError(
    describeFilesFailure(res.status, text),
    res.status,
    // Same slug the worker emits for the same condition — the edge cutting an
    // oversized request short is not a different failure from the worker
    // refusing it, and two codes made it look like one.
    code ?? (res.status === 413 ? 'too_large' : res.status >= 500 ? 'server_error' : 'http_error'),
    path,
    details,
  )
}

/** Parse a 2xx body that is supposed to be JSON, without assuming it is. */
async function readJson<T>(res: Response, path: string): Promise<T> {
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(
      `The DeepSpace platform returned a malformed (non-JSON) response.`,
      res.status,
      'invalid_response',
      path,
    )
  }
}

/**
 * A multipart body whose file part is the on-disk file itself.
 *
 * Composing a Blob from [preamble, file-backed Blob, epilogue] reads nothing
 * at construction time and keeps `.size` exact, so the request carries a real
 * Content-Length rather than falling back to chunked encoding.
 */
async function multipartBody(
  localPath: string,
  fileName: string,
  contentType: string,
): Promise<{ blob: Blob; contentType: string }> {
  const boundary = `----deepspace${randomUUID().replace(/-/g, '')}`
  // The filename lands in a quoted header parameter; a quote or CR/LF in it
  // would break out of the value. The uploaded KEY is carried by `?key=`, so
  // this only names the stored `originalName` metadata.
  const safeName = fileName.replace(/["\\\r\n]/g, '_')
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  const file = await openAsBlob(localPath, { type: contentType })
  return {
    blob: new Blob([head, file, `\r\n--${boundary}--\r\n`]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

export interface UploadResult {
  key: string
  name: string
  /** Bytes sent for the file itself (not the multipart envelope). */
  size: number
  /** How many requests carried the bytes. 1 means the single-request path. */
  parts: number
}

/** Told after each part lands, so a long upload is not a silent one. */
export type UploadProgress = (sent: number, total: number, part: number, parts: number) => void

/**
 * Upload one local file to a key relative to the app's allocation.
 *
 * A file that fits one request goes in one request. Above that it is chunked,
 * and the chunking is the whole point: peak memory is bounded by the PART
 * SIZE rather than by the file, so a 1 GiB upload costs roughly 40 MB (undici
 * materializes the slice it is sending, and the retry re-reads it) instead of
 * a gibibyte. Parts go sequentially — a failure must abandon a known amount of
 * work, and the terminal is one line, not four interleaved ones.
 *
 * The size check here only fails fast; the shared handler enforces the same
 * ceiling server-side, so skipping this cannot widen what is accepted.
 */
export async function uploadAppFile(
  baseUrl: string,
  token: string,
  appId: string,
  localPath: string,
  key: string,
  onProgress?: UploadProgress,
): Promise<UploadResult> {
  const path = filesPath(appId, `/upload?key=${encodeKeyPath(key)}`)
  const size = statSync(localPath).size
  if (size > MAX_APP_FILE_BYTES) {
    throw new ApiError(oversizeMessage(size), 0, 'too_large', path)
  }
  const declaredType = contentTypeFor(localPath)
  if (size > UPLOAD_PART_BYTES) {
    return uploadInParts(baseUrl, token, appId, localPath, key, size, onProgress)
  }
  const { blob, contentType } = await multipartBody(localPath, basename(localPath), declaredType)
  const res = await request(baseUrl, token, path, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: blob,
  })
  const body = await readJson<{ key: string; name: string }>(res, path)
  onProgress?.(size, size, 1, 1)
  return { key: body.key, name: body.name, size, parts: 1 }
}

interface MultipartSession {
  uploadId: string
  uploadKey: string
  reservationId: string
  partSize: number
}

/**
 * Worth one more attempt: the platform's own transient answers and a dropped
 * connection. A 4xx is the client's mistake and repeating it wastes a part
 * upload to reach the same refusal.
 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false
  return err.status === 0 || err.status === 429 || err.status >= 500
}

/**
 * The chunked path: init, parts, complete — and abort if anything fails.
 *
 * The server reply must agree with the SDK's fixed part layout. Refusing a
 * mismatch prevents a mixed-version client from uploading bytes the server
 * will reject at completion.
 */
async function uploadInParts(
  baseUrl: string,
  token: string,
  appId: string,
  localPath: string,
  key: string,
  size: number,
  onProgress?: UploadProgress,
): Promise<UploadResult> {
  const contentType = contentTypeFor(localPath)
  const initPath = filesPath(appId, `/multipart?key=${encodeKeyPath(key)}`)
  const requestId = randomUUID()
  const initBody = JSON.stringify({
    requestId,
    name: basename(localPath),
    mimeType: contentType,
    size,
  })
  const sendInit = (): Promise<MultipartSession> =>
    request(baseUrl, token, initPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: initBody,
    }).then((response) => readJson<MultipartSession>(response, initPath))
  let session: MultipartSession
  try {
    session = await sendInit()
  } catch (error) {
    if (!isRetryable(error)) throw error
    session = await sendInit()
  }

  const query =
    `uploadKey=${encodeKeyPath(session.uploadKey)}` +
    `&uploadId=${encodeURIComponent(session.uploadId)}` +
    `&reservationId=${encodeURIComponent(session.reservationId)}`
  if (
    !session.uploadId ||
    !session.uploadKey ||
    !session.reservationId ||
    session.partSize !== UPLOAD_PART_BYTES
  ) {
    throw new ApiError(
      `The platform returned an unusable part size or multipart session (${session.partSize}).`,
      0,
      'invalid_response',
      initPath,
    )
  }
  const plan = planUploadParts(size)
  const file = await openAsBlob(localPath, { type: contentType })
  const uploaded: Array<{ partNumber: number; etag: string }> = []
  try {
    for (const part of plan) {
      const partPath = filesPath(appId, `/multipart/part?${query}&partNumber=${part.partNumber}`)
      // The slice is a file-backed range whose exact size becomes the
      // Content-Length the server requires. It is rebuilt per attempt: a body
      // is consumed once, so a retry needs its own.
      const send = (): Promise<Response> =>
        request(baseUrl, token, partPath, {
          method: 'PUT',
          body: file.slice(part.start, part.end, contentType),
        })
      const res = await send().catch(async (err: unknown) => {
        // ONE retry, only for the failures the platform marks retryable —
        // without it a transient on part 40 of 52 throws away a gibibyte of
        // completed work. Not a loop: a second failure is the answer.
        if (!isRetryable(err)) throw err
        return send()
      })
      uploaded.push(await readJson<{ partNumber: number; etag: string }>(res, partPath))
      onProgress?.(part.end, size, part.partNumber, plan.length)
    }

    const completePath = filesPath(appId, `/multipart/complete?${query}`)
    const body = await readJson<{ key: string; name: string }>(
      await request(baseUrl, token, completePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: uploaded }),
      }),
      completePath,
    )
    return { key: body.key, name: body.name, size, parts: plan.length }
  } catch (err) {
    // Release whatever landed. A failed abort must not replace the real
    // failure — the upload is what the caller asked about.
    await request(baseUrl, token, filesPath(appId, `/multipart?${query}`), {
      method: 'DELETE',
    }).catch(() => undefined)
    throw err
  }
}

export interface ListResult {
  files: AppFileEntry[]
  truncated: boolean
  /** The allocation's whole usage against the owner's limit. Absent from an
   *  older worker; `limitBytes` absent when the platform's billing lookup was
   *  down (usage is still real). */
  storage?: { usedBytes: number; limitBytes?: number }
}

export async function listAppFiles(
  baseUrl: string,
  token: string,
  appId: string,
  query: URLSearchParams,
): Promise<ListResult> {
  const path = filesPath(appId, `?${query}`)
  return readJson<ListResult>(await request(baseUrl, token, path), path)
}

/** Delete a key. `existed` is false when there was nothing there — the API is
 *  idempotent by design, so the caller decides whether that is an error. */
export async function deleteAppFile(
  baseUrl: string,
  token: string,
  appId: string,
  key: string,
): Promise<{ existed: boolean }> {
  const path = filesPath(appId, `/${encodeKeyPath(key)}`)
  const res = await request(baseUrl, token, path, { method: 'DELETE' })
  const body = await readJson<{ existed: boolean }>(res, path)
  return { existed: body.existed }
}

export interface DownloadResult {
  bytes: number
  contentType: string
}

/** Stream one file down to `destination`, never buffering it whole. */
export async function downloadAppFile(
  baseUrl: string,
  token: string,
  appId: string,
  key: string,
  destination: string,
): Promise<DownloadResult> {
  const path = filesPath(appId, `/${encodeKeyPath(key)}`)
  const res = await request(baseUrl, token, path)
  if (!res.body) {
    throw new ApiError('The server returned an empty response', 502, 'invalid_response', path)
  }
  let bytes = 0
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    async function* (chunks) {
      for await (const chunk of chunks) {
        bytes += (chunk as Buffer).length
        yield chunk
      }
    },
    createWriteStream(destination),
  )
  return { bytes, contentType: res.headers.get('content-type') ?? 'application/octet-stream' }
}
