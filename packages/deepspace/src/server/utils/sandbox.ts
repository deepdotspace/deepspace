/**
 * Anthropic's hosted code-execution sandbox, through the DeepSpace proxy.
 *
 * Claude runs Python and shell in a container Anthropic hosts, so an agent can
 * read, edit and create real files (Word, Excel, PowerPoint, PDF, charts). The
 * container has no network: files go in and come out through Anthropic's
 * Files API, which the proxy scopes to this app (and, by default, to the
 * calling user — see `DeepSpaceAIOptions.sandboxScope`).
 *
 *   const ai = createDeepSpaceAI(env, 'anthropic', { authToken })
 *   const files = sandboxFiles(env, { authToken })
 *   const sheet = await files.upload(bytes, { filename: 'leads.xlsx' })
 *
 *   const result = streamText({            // stream: long jobs outlive a non-streamed call
 *     model: ai('claude-sonnet-5'),
 *     tools: { code_execution: codeExecutionTool(), crm_query: callableFromSandbox(crmQuery) },
 *     prepareStep: forwardSandboxContainer,          // same container across steps
 *     providerOptions: reuseSandbox(savedContainerId), // optional: across messages
 *     messages: [{ role: 'user', content: [{ type: 'text', text: 'Chart this' }, sandboxUpload(sheet)] }],
 *   })
 *
 *   const { containerId, fileIds } = sandboxOutputs(await result.steps)
 *   const chart = await files.download(fileIds[0])
 *
 * Stream sandbox calls (`streamText`). A non-streamed call that runs longer
 * than about two minutes is cut off with a 524 on its way to Anthropic —
 * multi-step document jobs routinely do.
 *
 * Billing: tokens as usual, plus a flat 5 container-minutes for each request
 * that used the sandbox. Files API calls are free.
 */

import { anthropic, forwardAnthropicContainerIdFromLastStep } from '@ai-sdk/anthropic'
import type { FilePart, Tool } from 'ai'
import type { SandboxScope } from '../../shared/sandbox'
import { resolveProxyAuthToken, setProxyHeaders, type DeepSpaceAIEnv } from './ai'
import { apiWorkerFetch } from './proxies'

const FILES_PATH = '/api/proxy/anthropic/v1/files'
/** The tool version that lets sandbox code call the app's own tools. */
const CODE_EXECUTION_CALLER = 'code_execution_20260120'

/** The code-execution tool. Add it to `tools`; Claude only starts a container when it uses it. */
export function codeExecutionTool(): Tool {
  return anthropic.tools.codeExecution_20260120()
}

/**
 * Let code running in the sandbox call this tool (programmatic tool calling),
 * in addition to Claude calling it directly. The call still runs in the app's
 * worker with the tool's own permission checks — the sandbox gets no
 * credentials. Anthropic waits about 4 minutes for each result.
 */
export function callableFromSandbox<T extends Tool>(tool: T): T {
  const anthropicOptions = tool.providerOptions?.anthropic
  return {
    ...tool,
    providerOptions: {
      ...tool.providerOptions,
      anthropic: { ...anthropicOptions, allowedCallers: ['direct', CODE_EXECUTION_CALLER] },
    },
  }
}

/** `prepareStep` that keeps every step of a turn in the first step's container. */
export const forwardSandboxContainer = forwardAnthropicContainerIdFromLastStep

/** `providerOptions` that continue in a container saved from an earlier turn. */
export function reuseSandbox(
  containerId: string | null | undefined,
): { anthropic: { container: { id: string } } } | undefined {
  return containerId ? { anthropic: { container: { id: containerId } } } : undefined
}

/** A message part that copies an uploaded file into the sandbox. */
export function sandboxUpload(file: Pick<SandboxFile, 'id' | 'filename' | 'mime_type'>): FilePart {
  return {
    type: 'file',
    mediaType: file.mime_type,
    filename: file.filename,
    data: { type: 'reference', reference: { anthropic: file.id } },
    providerOptions: { anthropic: { containerUpload: true } },
  }
}

interface SandboxStep {
  providerMetadata?: Record<string, unknown>
  content: ReadonlyArray<unknown>
}

function collectFileIds(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFileIds(item, out)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'file_id' && typeof child === 'string' && child) out.add(child)
    else collectFileIds(child, out)
  }
}

/**
 * The container a turn ran in (save it to continue later) and the files the
 * sandbox created (download them with `sandboxFiles`).
 */
export function sandboxOutputs(steps: ReadonlyArray<SandboxStep>): {
  containerId: string | null
  fileIds: string[]
} {
  let containerId: string | null = null
  const fileIds = new Set<string>()
  for (const step of steps) {
    const container = (step.providerMetadata?.anthropic as { container?: { id?: unknown } } | undefined)
      ?.container
    if (typeof container?.id === 'string') containerId = container.id
    for (const part of step.content) {
      const result = part as { type?: unknown; providerExecuted?: unknown; output?: unknown }
      if (result.type === 'tool-result' && result.providerExecuted) collectFileIds(result.output, fileIds)
    }
  }
  return { containerId, fileIds: [...fileIds] }
}

// ============================================================================
// Files
// ============================================================================

/** Anthropic's file metadata, as returned through the proxy. */
export interface SandboxFile {
  type: 'file'
  id: string
  filename: string
  mime_type: string
  size_bytes: number
  created_at: string
  /** Only files the sandbox created are downloadable; uploads are not. */
  downloadable?: boolean
  expires_at?: string | null
}

export interface SandboxFileList {
  data: SandboxFile[]
  /** Pass back as `page` for the next page; null on the last one. */
  next_page: string | null
}

export interface SandboxUploadOptions {
  /** Required when `file` is a Blob rather than a File. */
  filename?: string
  /** 3,600–7,776,000. The proxy defaults uploads to 30 days. */
  expiresInSeconds?: number
}

export interface SandboxFilesOptions {
  /** Same meaning as in `createDeepSpaceAI`: whose file it is, and who is billed. */
  authToken?: string
  /** Scope for files this client uploads. Must match the calls that will use them. */
  scope?: SandboxScope
}

export interface SandboxFilesClient {
  upload(file: Blob, options?: SandboxUploadOptions): Promise<SandboxFile>
  get(fileId: string): Promise<SandboxFile>
  /** The file's bytes as a streaming Response (content-type and content-disposition set). */
  download(fileId: string): Promise<Response>
  list(options?: { limit?: number; page?: string }): Promise<SandboxFileList>
  delete(fileId: string): Promise<void>
}

export class SandboxFileError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'SandboxFileError'
  }
}

/** Upload, read, list and delete the calling app's sandbox files. */
export function sandboxFiles(env: DeepSpaceAIEnv, options: SandboxFilesOptions = {}): SandboxFilesClient {
  const authToken = resolveProxyAuthToken(env, options)

  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    setProxyHeaders(headers, env, authToken, options.scope)
    const response = await apiWorkerFetch(env, `${FILES_PATH}${path}`, { ...init, headers })
    if (!response.ok) {
      const text = await response.text()
      let message = text || response.statusText
      try {
        const body = JSON.parse(text) as { error?: unknown }
        if (typeof body.error === 'string') message = body.error
        else if (body.error && typeof body.error === 'object') message = JSON.stringify(body.error)
      } catch { /* keep the raw text */ }
      throw new SandboxFileError(response.status, `Sandbox file request failed (${response.status}): ${message}`)
    }
    return response
  }

  const fileUrl = (fileId: string) => `/${encodeURIComponent(fileId)}`

  return {
    async upload(file, { filename, expiresInSeconds } = {}) {
      const name = filename ?? (file instanceof File ? file.name : undefined)
      if (!name) throw new SandboxFileError(400, 'sandboxFiles.upload: a Blob needs options.filename')
      const form = new FormData()
      form.set('file', file, name)
      if (expiresInSeconds !== undefined) form.set('expires_in_seconds', String(expiresInSeconds))
      return (await send('', { method: 'POST', body: form })).json()
    },
    async get(fileId) {
      return (await send(fileUrl(fileId))).json()
    },
    download(fileId) {
      return send(`${fileUrl(fileId)}/content`)
    },
    async list({ limit, page } = {}) {
      const query = new URLSearchParams()
      if (limit !== undefined) query.set('limit', String(limit))
      if (page !== undefined) query.set('page', page)
      const suffix = query.size > 0 ? `?${query}` : ''
      return (await send(suffix)).json()
    },
    async delete(fileId) {
      await send(fileUrl(fileId), { method: 'DELETE' })
    },
  }
}
