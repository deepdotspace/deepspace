/**
 * Integration API client.
 *
 * Plain functions for calling third-party integrations (OpenAI, weather, etc.)
 * through the DeepSpace API worker. Works anywhere — React components,
 * event handlers, server actions, outside React entirely.
 *
 * Usage:
 *   import { integration } from 'deepspace'
 *   const result = await integration.post('openai/chat-completion', { messages })
 */

import { getAuthToken } from './auth/token'
import { normalizeApiError, type ApiErrorIssue } from '../shared/api-error'

const ENDPOINT_PREFIX = '/api/integrations'
const DEFAULT_TIMEOUT_MS = 120_000
const ENDPOINT_RE = /^[a-z0-9][a-z0-9._~-]*(?:\/[a-z0-9][a-z0-9._~-]*)*$/i

interface IntegrationResponse<T = unknown> {
  success: boolean
  data?: T
  /** Human-readable error, safe to render directly. */
  error?: string
  /** Machine slug (e.g. 'insufficient_credits') for branching — never render it. */
  code?: string
  /** HTTP status of the failed response; 0 when no response arrived (timeout, abort, network). */
  status?: number
  /** Structured fields the server sent alongside the error (e.g. `availableCredits`). */
  details?: Record<string, unknown>
  issues?: ApiErrorIssue[]
}

interface RequestOptions {
  headers?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
}

function resolveUrl(endpoint: string): string {
  if (endpoint !== '' && !ENDPOINT_RE.test(endpoint)) {
    throw new TypeError(
      'Integration endpoints must be relative route segments, for example "openai/chat-completion".',
    )
  }
  const path = endpoint ? `${ENDPOINT_PREFIX}/${endpoint}` : ENDPOINT_PREFIX
  if (typeof window !== 'undefined') {
    return `${window.location.origin}${path}`
  }
  return path
}

async function request<T>(
  method: string,
  endpoint: string,
  body?: unknown,
  options?: RequestOptions,
  query?: URLSearchParams,
): Promise<IntegrationResponse<T>> {
  const queryString = query?.toString()
  const url = `${resolveUrl(endpoint)}${queryString ? `?${queryString}` : ''}`
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  if (options?.signal?.aborted) {
    return { success: false, error: 'Request cancelled', status: 0 }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options?.headers,
  }

  // Attach auth token if available
  try {
    const token = await getAuthToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
  } catch {
    // Not signed in — continue without auth
  }

  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  options?.signal?.addEventListener('abort', abortFromCaller, { once: true })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })

    let payload: Record<string, unknown>
    try {
      payload = (await res.json()) as Record<string, unknown>
    } catch {
      return { success: false, error: `Request failed (${res.status})`, status: res.status }
    }

    if (!res.ok || payload.success === false) {
      // The api-worker's envelope is { error: <machine slug>, message: <human>,
      // ...details } — normalize so `error` is always the human text and the
      // slug rides on `code` for branching.
      return { success: false, ...normalizeApiError(res.status, payload) }
    }

    // Normalize response — handle both { success, data } and { success, ...rest }
    if ('data' in payload) {
      return { success: true, data: payload.data as T }
    }
    const rest = { ...payload }
    delete rest.success
    return { success: true, data: rest as T }
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return {
        success: false,
        error: timedOut ? `Request timed out after ${timeoutMs}ms` : 'Request cancelled',
        status: 0,
      }
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Request failed',
      status: 0,
    }
  } finally {
    clearTimeout(timeout)
    options?.signal?.removeEventListener('abort', abortFromCaller)
  }
}

export const integration = {
  post<T = unknown>(endpoint: string, data?: unknown, options?: RequestOptions) {
    return request<T>('POST', endpoint, data, options)
  },
  get<T = unknown>(
    endpoint: string,
    params?: Record<string, string | number | boolean | null | undefined>,
    options?: RequestOptions,
  ) {
    let searchParams: URLSearchParams | undefined
    if (params) {
      searchParams = new URLSearchParams()
      for (const [k, v] of Object.entries(params)) {
        if (v != null) searchParams.set(k, String(v))
      }
    }
    return request<T>('GET', endpoint, undefined, options, searchParams)
  },
  put<T = unknown>(endpoint: string, data?: unknown, options?: RequestOptions) {
    return request<T>('PUT', endpoint, data, options)
  },
  delete<T = unknown>(endpoint: string, data?: unknown, options?: RequestOptions) {
    return request<T>('DELETE', endpoint, data, options)
  },
}

export type { IntegrationResponse, RequestOptions }
