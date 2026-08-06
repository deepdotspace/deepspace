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
  describeFilesFailure,
  encodeKeyPath,
  formatBytes,
  oversizeMessage,
} from '../../shared/app-files'

export { MAX_APP_FILE_BYTES, encodeKeyPath, formatBytes }

export interface AppFileEntry {
  key: string
  size: number
  uploaded: string
  originalName?: string
}

/**
 * Extensions worth naming explicitly. Anything unlisted uploads as
 * `application/octet-stream`, which stores and serves fine — the type only
 * decides the Content-Type a browser later sees. The server independently
 * refuses types it would execute as active content (HTML, SVG, JS), so a
 * guess here can never widen what is accepted.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
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
  try {
    code = (JSON.parse(text.trim()) as { code?: string }).code
  } catch {
    // Not the app's JSON; the status carries the meaning.
  }
  throw new ApiError(
    describeFilesFailure(res.status, text),
    res.status,
    code ?? (res.status === 413 ? 'file_too_large' : res.status >= 500 ? 'server_error' : 'http_error'),
    path,
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
}

/**
 * Upload one local file to a key relative to the app's allocation.
 *
 * The size check here only fails fast; the shared upload handler enforces the
 * same ceiling server-side, so skipping this cannot widen what is accepted.
 */
export async function uploadAppFile(
  baseUrl: string,
  token: string,
  appId: string,
  localPath: string,
  key: string,
): Promise<UploadResult> {
  const path = filesPath(appId, `/upload?key=${encodeKeyPath(key)}`)
  const size = statSync(localPath).size
  if (size > MAX_APP_FILE_BYTES) {
    throw new ApiError(oversizeMessage(size), 0, 'file_too_large', path)
  }
  const { blob, contentType } = await multipartBody(
    localPath,
    basename(localPath),
    contentTypeFor(localPath),
  )
  const res = await request(baseUrl, token, path, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: blob,
  })
  const body = await readJson<{ key: string; name: string }>(res, path)
  return { key: body.key, name: body.name, size }
}

export interface ListResult {
  files: AppFileEntry[]
  truncated: boolean
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

export async function deleteAppFile(
  baseUrl: string,
  token: string,
  appId: string,
  key: string,
): Promise<void> {
  await request(baseUrl, token, filesPath(appId, `/${encodeKeyPath(key)}`), { method: 'DELETE' })
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
