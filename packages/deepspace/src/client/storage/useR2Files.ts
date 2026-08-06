/**
 * useR2Files — Scoped file storage hook for DeepSpace apps.
 *
 * Provides upload, download, list, and delete for files in R2.
 *
 * Uploads pick their own transport. A small file goes in one request; a large
 * one is chunked into parts with `Blob.slice`, so peak memory is bounded by
 * the PART SIZE rather than by the file — a 1 GiB video costs one part, not a
 * gibibyte — and the file ceiling becomes a product decision rather than a
 * request-size accident. Callers do nothing differently either way.
 *
 * Two scopes are supported via the `scope` option:
 *   - `'self'` (default): per-user storage. Reads require auth.
 *   - `'app'`: app-wide storage. Reads are public — the upload URL works
 *     directly as an `<img src>`. Use for avatars, logos, etc.
 *
 * @example
 * ```tsx
 * // Per-user files (default):
 * const { upload, downloadFile } = useR2Files()
 * await upload(myFile, 'photo.png')
 *
 * // App-shared files (public reads — usable in <img src>):
 * const { upload } = useR2Files({ scope: 'app' })
 * const r = await upload(file, `avatars/${userId}.png`)
 * // r.url is a plain, anon-readable URL.
 * ```
 */

import { useCallback, useState, useMemo } from 'react'
import { getAuthToken } from '../auth'
import {
  MAX_APP_FILE_BYTES,
  MAX_BASE64_UPLOAD_BYTES,
  UPLOAD_PART_BYTES,
  describeFilesFailure,
  encodeKeyPath,
  oversizeMessage,
  planUploadParts,
} from '../../shared/app-files'

// ============================================================================
// Types
// ============================================================================

export interface R2UploadResult {
  success: boolean
  key?: string
  url?: string
  name?: string
  error?: string
}

/**
 * Read an upload response without assuming it is JSON.
 *
 * An over-limit upload is refused by the edge, not the app, and comes back as
 * an HTML error page — `response.json()` on that throws `Unexpected token '<'`,
 * which is what users saw instead of "your file is too big".
 */
/** The one client-side size check, for both upload shapes. */
function oversize(bytes: number, limit = MAX_APP_FILE_BYTES): R2UploadResult | null {
  return bytes > limit ? { success: false, error: oversizeMessage(bytes, limit) } : null
}

async function readUploadResult(response: Response): Promise<R2UploadResult> {
  const text = await response.text()
  if (response.ok) {
    try {
      return JSON.parse(text) as R2UploadResult
    } catch {
      return { success: false, error: 'The files service returned a malformed response.' }
    }
  }
  return { success: false, error: describeFilesFailure(response.status, text) }
}

export interface R2FileInfo {
  key: string
  size: number
  uploaded: string
  url: string
  originalName?: string
  uploadedBy?: string
}

/** Told after each part lands, so a long upload can drive a progress bar. */
export type UploadProgress = (sent: number, total: number) => void

export interface UploadOptions {
  onProgress?: UploadProgress
}

export interface UseR2FilesReturn {
  /**
   * Upload a File or Blob. Optionally provide a display name.
   *
   * A file above the single-request bound is chunked automatically and sent as
   * parts — nothing to opt into, and nothing held in memory beyond one part.
   * Pass `onProgress` to follow a large one.
   */
  upload: (
    file: File | Blob,
    name?: string,
    options?: UploadOptions,
  ) => Promise<R2UploadResult>
  /**
   * Upload raw base64 data.
   *
   * Single-request only: base64 has to be materialized whole to be decoded, so
   * this path keeps the one-request bound rather than the file ceiling — and
   * because the request carries the ENCODED string, its real budget is
   * `MAX_BASE64_UPLOAD_BYTES` (~18.75 MiB decoded), not the full 25 MiB. Send a
   * Blob through `upload` for anything larger; it chunks.
   */
  uploadBase64: (base64Data: string, name: string, mimeType?: string) => Promise<R2UploadResult>
  /**
   * Delete a file. Accepts an R2FileInfo from `list()` or a raw key string.
   *
   * @example
   * ```tsx
   * const files = await list()
   * await deleteFile(files[0])          // pass the object
   * await deleteFile('widgets/abc/f.pdf') // or a raw key
   * ```
   */
  deleteFile: (fileOrKey: R2FileInfo | string) => Promise<{ success: boolean; error?: string }>
  /** List files, optionally filtered by a sub-prefix within the scope. */
  list: (prefix?: string) => Promise<R2FileInfo[]>
  /**
   * Download a file. Accepts an R2FileInfo from `list()` or a raw key string.
   * Uses an authenticated fetch and triggers a browser download via blob URL.
   *
   * When an R2FileInfo is passed, `originalName` is used as the download
   * filename automatically. When a string key is passed, an optional
   * `fileName` override can be provided.
   *
   * @example
   * ```tsx
   * const files = await list()
   * await downloadFile(files[0])                         // uses originalName
   * await downloadFile('widgets/abc/f.pdf', 'report.pdf') // explicit name
   * ```
   */
  downloadFile: (
    fileOrKey: R2FileInfo | string,
    fileName?: string,
  ) => Promise<{ success: boolean; error?: string }>
  /**
   * Read a file's contents with authentication. Returns the raw Response.
   * Unlike `downloadFile`, this does NOT trigger a browser download —
   * it returns the Response so you can call `.text()`, `.blob()`,
   * `.arrayBuffer()`, `.json()`, etc.
   *
   * @example
   * ```tsx
   * const resp = await readFile('data/cleaned.txt')
   * const text = await resp.text()
   * ```
   */
  readFile: (fileOrKey: R2FileInfo | string) => Promise<Response>
  /**
   * Build a plain URL for a file. Accepts an R2FileInfo or a raw key string.
   *
   * **Note**: This URL has no auth token attached. It works for `'app'`-scope
   * files (which are publicly readable) but not for `'self'`-scope files —
   * those require an Authorization header, so use `readFile` / `downloadFile`.
   */
  getUrl: (fileOrKey: R2FileInfo | string) => string
  /** Whether an upload is currently in progress. */
  isUploading: boolean
}

/**
 * Scope controls where files live and who can read them:
 *
 *  - `'self'` (default) — `apps/<app>/users/<userId>/…`. Per-user storage.
 *    Reads require the caller's auth token; not usable from a plain `<img>`
 *    or unauthenticated browser request.
 *  - `'app'` — `apps/<app>/…`. Shared by everyone in the app. Reads are
 *    public (no auth header needed), so the upload URL works directly as
 *    an `<img src>`. Use this for avatars, logos, attachments, and other
 *    assets meant to be embedded in pages.
 *
 * Uploads under `'app'` still require a signed-in user.
 */
export type R2Scope = { scope?: 'self' | 'app' }

// ============================================================================
// Helpers
// ============================================================================

/** Extract key (and optional original name) from an R2FileInfo or raw string. */
function resolveFile(fileOrKey: R2FileInfo | string): { key: string; name: string | undefined } {
  if (typeof fileOrKey === 'string') {
    return { key: fileOrKey, name: undefined }
  }
  return { key: fileOrKey.key, name: fileOrKey.originalName }
}

interface MultipartSession {
  uploadId: string
  uploadKey: string
  partSize: number
}

/**
 * Upload a file too large for one request, as a sequence of parts.
 *
 * `Blob.slice` is a lazy view rather than a copy, so the range is materialized
 * only while it is being sent: peak memory is one part, not one file, and a
 * 1 GiB video never becomes 1 GiB of tab memory. Its exact size becomes the
 * Content-Length the server requires. Parts go one at a time: they must,
 * because R2 sizes non-final parts uniformly and a half-uploaded object must be
 * abandonable in one call.
 *
 * The server names the key and the part size. Nothing here invents either — a
 * client that picked its own key could write over a sibling file, and one that
 * picked its own part size could assemble an upload R2 refuses — but what the
 * server says is validated before it is looped on.
 */
async function uploadInParts(
  file: File | Blob,
  name: string,
  scopeParams: string,
  authHeaders: () => Promise<Record<string, string>>,
  onProgress?: UploadProgress,
): Promise<R2UploadResult> {
  const headers = await authHeaders()
  const json = { ...headers, 'Content-Type': 'application/json' }
  const initResponse = await fetch(`/api/files/multipart?${scopeParams}`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ name, mimeType: file.type || 'application/octet-stream', size: file.size }),
  })
  if (!initResponse.ok) return await readUploadResult(initResponse)
  const session = (await initResponse.json()) as MultipartSession
  if (!Number.isSafeInteger(session.partSize) || session.partSize < 1) {
    return {
      success: false,
      error: `The files service advertised an unusable part size (${session.partSize}).`,
    }
  }

  const query =
    `${scopeParams}&uploadKey=${encodeKeyPath(session.uploadKey)}` +
    `&uploadId=${encodeURIComponent(session.uploadId)}`
  const plan = planUploadParts(file.size, session.partSize)
  const parts: Array<{ partNumber: number; etag: string }> = []
  let assembled = false
  try {
    for (const part of plan) {
      // The slice is rebuilt per attempt: a body is consumed once, so a retry
      // needs its own.
      const send = (): Promise<Response> =>
        fetch(`/api/files/multipart/part?${query}&partNumber=${part.partNumber}`, {
          method: 'PUT',
          headers,
          body: file.slice(part.start, part.end),
        })
      let response = await send().catch(() => null)
      // ONE retry, only for the answers the platform marks retryable —
      // otherwise a transient on part 40 of 52 throws away everything already
      // uploaded. Not a loop: a second failure is the answer.
      if (!response || response.status === 429 || response.status >= 500) {
        const retried = await send().catch(() => null)
        if (retried) response = retried
      }
      if (!response) return { success: false, error: 'The files service could not be reached.' }
      if (!response.ok) return await readUploadResult(response)
      parts.push((await response.json()) as { partNumber: number; etag: string })
      onProgress?.(part.end, file.size)
    }
    const completed = await fetch(`/api/files/multipart/complete?${query}`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ parts }),
    })
    assembled = completed.ok
    return await readUploadResult(completed)
  } finally {
    // Anything short of an assembled object leaves parts holding space in the
    // customer's allocation. R2 would reap the session in 7 days; releasing it
    // now is the difference between a retry loop that costs nothing and one
    // that fills the app up.
    if (!assembled) {
      await fetch(`/api/files/multipart?${query}`, { method: 'DELETE', headers }).catch(
        () => undefined,
      )
    }
  }
}

// ============================================================================
// Hook
// ============================================================================

export function useR2Files(options?: R2Scope): UseR2FilesReturn {
  const [isUploading, setIsUploading] = useState(false)
  const scope = options?.scope ?? 'self'

  /** Query string that tells the worker which scope to use. */
  const scopeParams = useMemo(() => {
    const params = new URLSearchParams()
    params.set('scope', scope)
    return params.toString()
  }, [scope])

  /** Get auth headers using the DeepSpace auth token. */
  const authHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const token = await getAuthToken()
    if (token) {
      return { Authorization: `Bearer ${token}` }
    }
    return {}
  }, [])

  const upload = useCallback(
    async (
      file: File | Blob,
      name?: string,
      options?: UploadOptions,
    ): Promise<R2UploadResult> => {
      setIsUploading(true)
      try {
        const tooBig = oversize(file.size)
        if (tooBig) return tooBig
        const fileName = name ?? (file instanceof File ? file.name : 'upload')
        if (file.size > UPLOAD_PART_BYTES) {
          return await uploadInParts(file, fileName, scopeParams, authHeaders, options?.onProgress)
        }
        const headers = await authHeaders()
        const formData = new FormData()
        formData.append('file', file)
        if (name) formData.append('name', name)

        const response = await fetch(`/api/files/upload?${scopeParams}`, {
          method: 'POST',
          headers,
          body: formData,
        })
        options?.onProgress?.(file.size, file.size)
        return await readUploadResult(response)
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Upload failed' }
      } finally {
        setIsUploading(false)
      }
    },
    [scopeParams, authHeaders],
  )

  const uploadBase64 = useCallback(
    async (base64Data: string, name: string, mimeType?: string): Promise<R2UploadResult> => {
      setIsUploading(true)
      try {
        // The REQUEST is the encoded string, and that is what has to fit:
        // base64 spends 4 characters per 3 bytes, so measuring only the
        // decoded payload against the request bound passes files whose bodies
        // are a third larger than the server accepts — a check that green-lights
        // uploads the server then always 413s. Measured decoded, compared
        // against the decoded budget the request bound actually leaves.
        const tooBig = oversize(
          Math.floor((base64Data.length * 3) / 4),
          MAX_BASE64_UPLOAD_BYTES,
        )
        if (tooBig) return tooBig
        const headers = await authHeaders()
        const response = await fetch(`/api/files/upload?${scopeParams}`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: base64Data, name, mimeType }),
        })
        return await readUploadResult(response)
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Upload failed' }
      } finally {
        setIsUploading(false)
      }
    },
    [scopeParams, authHeaders],
  )

  const deleteFile = useCallback(
    async (fileOrKey: R2FileInfo | string): Promise<{ success: boolean; error?: string }> => {
      const { key } = resolveFile(fileOrKey)
      try {
        const headers = await authHeaders()
        const response = await fetch(`/api/files/${encodeKeyPath(key)}?${scopeParams}`, {
          method: 'DELETE',
          headers,
        })
        return (await response.json()) as { success: boolean; error?: string }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Delete failed' }
      }
    },
    [scopeParams, authHeaders],
  )

  const list = useCallback(
    async (prefix?: string): Promise<R2FileInfo[]> => {
      try {
        const headers = await authHeaders()
        const params = new URLSearchParams(scopeParams)
        if (prefix) params.set('prefix', prefix)
        const response = await fetch(`/api/files?${params.toString()}`, { headers })
        const result = (await response.json()) as { files: R2FileInfo[] }
        return result.files || []
      } catch {
        return []
      }
    },
    [scopeParams, authHeaders],
  )

  const downloadFile = useCallback(
    async (
      fileOrKey: R2FileInfo | string,
      fileName?: string,
    ): Promise<{ success: boolean; error?: string }> => {
      const { key, name: infoName } = resolveFile(fileOrKey)
      try {
        const headers = await authHeaders()
        const response = await fetch(`/api/files/${encodeKeyPath(key)}?${scopeParams}`, { headers })

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null
          return { success: false, error: body?.error ?? `Download failed (${response.status})` }
        }

        // Derive a display name: explicit arg > R2FileInfo.originalName > Content-Disposition > last key segment
        const disposition = response.headers.get('Content-Disposition')
        const dispositionName = disposition?.match(/filename="(.+?)"/)?.[1]
        const fallbackName = key.split('/').pop() ?? 'download'
        const resolvedName = fileName ?? infoName ?? dispositionName ?? fallbackName

        const blob = await response.blob()
        const blobUrl = URL.createObjectURL(blob)

        const anchor = document.createElement('a')
        anchor.href = blobUrl
        anchor.download = resolvedName
        document.body.appendChild(anchor)
        anchor.click()

        // Clean up
        document.body.removeChild(anchor)
        URL.revokeObjectURL(blobUrl)

        return { success: true }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Download failed' }
      }
    },
    [scopeParams, authHeaders],
  )

  const readFile = useCallback(
    async (fileOrKey: R2FileInfo | string): Promise<Response> => {
      const { key } = resolveFile(fileOrKey)
      const headers = await authHeaders()
      const response = await fetch(`/api/files/${encodeKeyPath(key)}?${scopeParams}`, { headers })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`Failed to read file (${response.status}): ${body}`)
      }
      return response
    },
    [scopeParams, authHeaders],
  )

  const getUrl = useCallback(
    (fileOrKey: R2FileInfo | string): string => {
      const { key } = resolveFile(fileOrKey)
      return `/api/files/${encodeKeyPath(key)}?${scopeParams}`
    },
    [scopeParams],
  )

  return { upload, uploadBase64, deleteFile, downloadFile, readFile, list, getUrl, isUploading }
}
