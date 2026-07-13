/**
 * Authenticated JSON fetch against a platform worker.
 *
 * Shared by the CLI commands that call the platform as the logged-in user
 * (`domain`, `feedback`, `collaborators`, `transfer`, …). Sends a Bearer
 * token, parses the JSON body, and on a non-2xx response throws an ApiError
 * carrying the worker's `{ error, code }` — message for display, code for
 * branching — so callers never string-sniff error text.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** Internal REST path — kept off the message (DEBUG-only rendering). */
    readonly apiPath?: string,
  ) {
    super(message)
  }
}

export async function apiFetch<T>(
  baseUrl: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = text
    let code: string | undefined
    try {
      const body = JSON.parse(text) as { error?: string; code?: string }
      msg = body.error ?? text
      code = body.code
    } catch {
      // not JSON
    }
    // Message = the server's sentence only. The internal REST path and raw
    // status read like a stack trace to users (same treatment as secretsApi);
    // they stay on the error's fields for DEBUG rendering and branching.
    throw new ApiError(msg || `Request failed (${res.status})`, res.status, code, path)
  }
  return (text ? JSON.parse(text) : {}) as T
}
