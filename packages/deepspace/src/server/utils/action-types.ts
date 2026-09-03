/**
 * Server Action Types
 *
 * Types for app-defined server actions that run in the site worker.
 * Actions bypass user RBAC via the X-App-Action header — the app's
 * server-side code IS the trust boundary.
 */

import type { RecordResult } from '../../shared/types'
import type { ApiErrorIssue } from '../../shared/api-error'

/**
 * Discriminated result wrapper. Narrowing on `.success` lets TS know
 * `.data` is present in the success branch and `.error` in the failure
 * branch, so callers can't read the wrong field by accident.
 *
 * `TData` is the per-operation data shape — `tools.query` returns
 * `{ records, count }`, `tools.get` returns `{ record }`, etc. Apps
 * that compose their own server actions can specialize further.
 */
export type ActionResult<TData = unknown> =
  | { success: true; data: TData; error?: never }
  | {
      success: false
      data?: never
      /** Human-readable error, safe to render directly. */
      error: string
      /** Machine slug for branching, when the failing tool supplied one. */
      code?: string
      /** HTTP status from an upstream platform request, when applicable. */
      status?: number
      /** Structured fields supplied with the error response. */
      details?: Record<string, unknown>
      /** Validation issues supplied with a `validation_failed` response. */
      issues?: ApiErrorIssue[]
    }

/** Shape of the data field for `tools.query`. */
export interface QueryActionData<T = Record<string, unknown>> {
  records: Array<RecordResult & { data: T }>
  count: number
}

/** Shape of the data field for `tools.get`. */
export interface GetActionData<T = Record<string, unknown>> {
  record: RecordResult & { data: T }
}

/** Shape of the data field for `tools.create`/`update`/`remove`. */
export interface MutateActionData {
  recordId: string
}

export interface ActionTools {
  /**
   * Insert a new record. When `recordId` is omitted the DO generates one
   * (typical). Pass `recordId` to upsert against a known key — useful
   * for `users` where the row id must equal the auth user's id so
   * `tools.get('users', userId)` resolves.
   */
  create<T extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    data: T,
    recordId?: string,
  ): Promise<ActionResult<MutateActionData>>
  update<T extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    recordId: string,
    data: Partial<T>,
  ): Promise<ActionResult<MutateActionData>>
  remove(collection: string, recordId: string): Promise<ActionResult<MutateActionData>>
  /**
   * Delete every record matching `where`, in one bounded batch — the cascade
   * primitive, so draining a set costs one subrequest per page instead of one
   * per row. Deletes at most `limit` (default 100, max 500) and returns
   * `{ deleted }`; repeat the same call until `deleted` is below the limit to
   * drain a larger set.
   *
   * `where` must be non-empty and every key must name a real field
   * (`recordId`, `createdBy`, or a schema column) — an unknown key is refused,
   * not ignored, so this can never truncate a whole collection.
   */
  deleteWhere(
    collection: string,
    where: Record<string, unknown>,
    limit?: number,
  ): Promise<ActionResult<{ deleted: number }>>
  get<T extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    recordId: string,
  ): Promise<ActionResult<GetActionData<T>>>
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    options?: {
      where?: Record<string, unknown>
      orderBy?: string
      orderDir?: 'asc' | 'desc'
      limit?: number
    },
  ): Promise<ActionResult<QueryActionData<T>>>
  /**
   * Call an integration endpoint (e.g. 'openai/chat-completion') via the
   * api-worker. On success, `result.data` is the integration's response
   * body directly — there is no `.response` wrapper. So an OpenAI call
   * yields `result.data.choices`, a Freepik image call yields
   * `result.data.images`, etc. On failure, `result.error` is human-readable;
   * branch on `result.code` and inspect `status`, `details`, or `issues` when
   * present.
   */
  integration<T = unknown>(
    endpoint: string,
    data?: unknown,
  ): Promise<ActionResult<T>>
  /**
   * Insert or refresh the `users` row for an authenticated caller.
   * Mirrors the WS-connect registerUser flow — useful for CLI-only
   * actions (e.g. publishing via `deepspace foo publish`) where the
   * caller may never have opened the web app and has no `users` row
   * yet. Bypasses SYSTEM_MANAGED column stripping so name/email/
   * imageUrl are actually written.
   *
   * Defaults `userId` to the action's caller. Pass `isAdmin: true` only
   * if the caller's platform-tier role is admin (worker.ts should
   * derive this from the verified JWT — never trust client input).
   */
  registerUser(opts: {
    userId?: string
    name?: string
    email?: string
    imageUrl?: string
    isAdmin?: boolean
  }): Promise<ActionResult<{ user: { id: string; name: string; email: string; imageUrl?: string; role: string } }>>
}

/**
 * `TEnv` lets apps type the worker-scoped env object passed to the
 * action handler. Defaults to a loose `Record<string, unknown>` so
 * unparameterized handlers still compile; apps that want strict typing
 * can do `ActionHandler<Env>` where Env is their own worker's bindings
 * interface.
 */
export interface ActionContext<TEnv = Record<string, unknown>> {
  userId: string
  params: Record<string, unknown>
  tools: ActionTools
  /**
   * The worker's env bindings. Used by actions that need access to
   * secrets, bindings, or platform-injected values like `OWNER_USER_ID`
   * (e.g. for owner-only action gating).
   */
  env: TEnv
  /**
   * The caller's raw JWT. Forward this on outbound requests that need to
   * impersonate the user (e.g. checking `/api/apps` ownership on the
   * deploy worker, where the user — not the app owner — should be billed
   * / authorized).
   */
  callerJwt: string
}

export type ActionHandler<TEnv = Record<string, unknown>> = (
  ctx: ActionContext<TEnv>,
) => Promise<ActionResult>
