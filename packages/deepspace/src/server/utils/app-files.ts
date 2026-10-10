/**
 * appFiles — the app's own file storage, from Worker code.
 *
 * The browser reaches app files through `useR2Files` and the app's
 * `/api/files` proxy, and the owner through `deepspace app files`. Server code
 * (an agent tool, a cron job, an action that renders a report) had no
 * supported way in, so apps hand-built the `/internal/files` request and its
 * identity headers. This is that request, written once.
 *
 * Auth is the app's HMAC identity (`appendAppIdentity`), and the platform
 * trusts the `userId` given here as the app's own verified user. Pass an id
 * the app has verified (a tool context's `userId`, `c.get('userId')`), never
 * one taken from request input. `self` is that user's private folder, the
 * files `/api/files?scope=self` serves to them alone; `app` is the public
 * allocation, and the user is recorded as its uploader.
 *
 * Keys follow `useR2Files`: `upload` takes a key relative to the scope and
 * answers with the stored `key`, which `download` and `delete` take and which
 * is what an app keeps in its records (`/api/files/<key>?scope=…` serves it).
 *
 * @example
 * ```ts
 * // In an agent tool: store a screenshot only the caller can open.
 * const files = appFiles(context.env, { scope: 'self', userId: context.userId })
 * const { key } = await files.upload(new Blob([png], { type: 'image/png' }), {
 *   key: `cards/${cardId}/shot.png`,
 * })
 * ```
 */
import {
  MAX_UPLOAD_REQUEST_BYTES,
  appFilePath,
  describeFilesFailure,
  encodeKeyPath,
  formatBytes,
  type AppFileScope,
} from '../../shared/app-files'
import { appendAppIdentity, type AppIdentityEnv } from './app-identity'
import { platformWorkerFetch, type PlatformWorkerEnv } from './proxies'

export interface AppFilesEnv extends PlatformWorkerEnv, AppIdentityEnv {}

export interface AppFilesOptions {
  /** `self`: the user's private folder. `app`: the app's public files. */
  scope: AppFileScope
  /** A user id the app has verified. */
  userId: string
}

export interface AppFile {
  /** The stored key: what `download`, `delete` and `/api/files/<key>` take. */
  key: string
  /** `key` within the scope, the spelling `upload({ key })` and `list({ prefix })` use. */
  relativeKey: string
  /** Where the app serves it, relative to the app's origin. */
  path: string
}

export interface AppFileInfo extends AppFile {
  size: number
  uploaded: string
}

export interface AppFileList {
  files: AppFileInfo[]
  /** Pass back as `cursor` for the next page; present only while there is one. */
  cursor?: string
}

export interface AppFilesClient {
  /**
   * Store a file in one request (at most 25 MiB; larger files belong to
   * `useR2Files` or the CLI, which upload in parts). With `key` the file
   * replaces whatever is there; without it the platform picks a unique key.
   */
  upload(file: Blob, options?: { key?: string; name?: string }): Promise<AppFile>
  /** The file's bytes as a streaming Response. Throws `AppFileError` (404) when absent. */
  download(key: string): Promise<Response>
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<AppFileList>
  /** Deletes the file; `existed` is false when there was nothing at `key`. */
  delete(key: string): Promise<{ existed: boolean }>
}

export class AppFileError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'AppFileError'
  }
}

export function appFiles(env: AppFilesEnv, options: AppFilesOptions): AppFilesClient {
  const { scope, userId } = options
  if (!userId) throw new AppFileError(400, 'appFiles: a verified userId is required')

  async function send(path: string, query: Record<string, string>, init: RequestInit = {}) {
    // Without the token the platform can only answer "missing app identity";
    // say what is actually wrong.
    if (!env.APP_IDENTITY_TOKEN) {
      throw new AppFileError(
        503,
        'App file storage needs the app identity token, which the first `deepspace deploy` provides.',
      )
    }
    const headers = new Headers(init.headers)
    appendAppIdentity(headers, env)
    headers.set('x-user-id', userId)
    const params = new URLSearchParams({ ...query, scope })
    const response = await platformWorkerFetch(env, `/internal/files${path}?${params}`, {
      ...init,
      headers,
    })
    if (!response.ok) {
      throw new AppFileError(
        response.status,
        describeFilesFailure(response.status, await response.text()),
      )
    }
    return response
  }

  const keyPath = (key: string) => `/${encodeKeyPath(key)}`

  return {
    async upload(file, { key, name } = {}) {
      if (file.size > MAX_UPLOAD_REQUEST_BYTES) {
        throw new AppFileError(
          413,
          `That file is ${formatBytes(file.size)}; appFiles stores up to ` +
            `${formatBytes(MAX_UPLOAD_REQUEST_BYTES)} in one request. Upload larger files from ` +
            'the browser with useR2Files or with `deepspace app files put`, which send parts.',
        )
      }
      const form = new FormData()
      form.append('file', file, name ?? (file instanceof File ? file.name : 'upload'))
      // The platform requires a Content-Length, which a streamed FormData
      // body may not carry; serializing once gives the body a known size.
      const encoded = new Request('https://encode.invalid', { method: 'POST', body: form })
      const body = await encoded.arrayBuffer()
      const response = await send('/upload', key ? { key } : {}, {
        method: 'POST',
        headers: { 'content-type': encoded.headers.get('content-type') ?? '' },
        body,
      })
      const stored = (await response.json()) as { key: string; relativeKey: string }
      return { key: stored.key, relativeKey: stored.relativeKey, path: appFilePath(stored.key, scope) }
    },

    download(key) {
      return send(keyPath(key), {})
    },

    async list({ prefix, limit, cursor } = {}) {
      const query: Record<string, string> = {}
      if (prefix) query.prefix = prefix
      if (limit !== undefined) query.limit = String(limit)
      if (cursor) query.cursor = cursor
      const body = (await (await send('', query)).json()) as {
        files: Array<{ key: string; relativeKey: string; size: number; uploaded: string }>
        cursor?: string
      }
      return {
        files: body.files.map((file) => ({
          key: file.key,
          relativeKey: file.relativeKey,
          path: appFilePath(file.key, scope),
          size: file.size,
          uploaded: file.uploaded,
        })),
        ...(body.cursor ? { cursor: body.cursor } : {}),
      }
    },

    async delete(key) {
      const body = (await (await send(keyPath(key), {}, { method: 'DELETE' })).json()) as {
        existed: boolean
      }
      return { existed: body.existed }
    },
  }
}
