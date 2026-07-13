/**
 * Cron System — Server-Side Scheduled Tasks
 *
 * Provides CronContext for miniapp cron handlers and buildCronContext
 * to construct it from worker environment bindings.
 *
 * CronContext gives handlers access to:
 *   - records: Query/create/update/delete via RecordRoom tools API
 *   - integrations: Call platform integration endpoints, billed to the app owner
 *   - ownerUserId: The app owner's user ID
 */

import { apiWorkerFetch, type ApiWorkerEnv } from './proxies'

/** Context passed to cron handler functions */
export interface CronContext {
  /** RecordRoom data access (queries the DO directly via tools API) */
  records: {
    query(collection: string, opts?: { where?: Record<string, unknown>; limit?: number }): Promise<unknown[]>
    create(collection: string, data: Record<string, unknown>): Promise<unknown>
    update(collection: string, recordId: string, data: Record<string, unknown>): Promise<unknown>
    delete(collection: string, recordId: string): Promise<unknown>
  }
  /**
   * Call a platform integration endpoint (e.g. "openai/chat-completion",
   * "fal/run-model"). Billed to the app owner using the same
   * APP_OWNER_JWT the rest of the SDK uses for server-side billed calls.
   */
  integrations: {
    call(endpoint: string, params?: Record<string, unknown>): Promise<unknown>
  }
  /** App owner's user ID */
  ownerUserId: string
}

/** Environment bindings needed by buildCronContext */
interface CronEnv extends ApiWorkerEnv {
  RECORD_ROOMS: DurableObjectNamespace
  /**
   * Long-lived app-owner JWT minted at deploy time. Required for
   * `integrations.call()` so the call is billed to the app owner.
   * Optional here so apps that don't use integrations from cron can omit
   * it without a type error; missing-at-call-time throws a clear message.
   */
  APP_OWNER_JWT?: string
}

/**
 * Build a CronContext from worker environment bindings.
 *
 * @param env - Worker environment with RECORD_ROOMS DO namespace, APP_OWNER_JWT, and an api-worker transport (API_WORKER binding or API_WORKER_URL)
 * @param ownerUserId - App owner's user ID (for RBAC and billing)
 * @param roomId - RecordRoom ID (defaults to 'default')
 */
export function buildCronContext(
  env: CronEnv,
  ownerUserId: string,
  roomId = 'default'
): CronContext {
  // Get the RecordRoom DO stub for direct internal calls
  const roomIdObj = env.RECORD_ROOMS.idFromName(roomId)
  const room = env.RECORD_ROOMS.get(roomIdObj)

  /** Execute a tool call against the RecordRoom's tools API */
  async function executeTool(tool: string, params: Record<string, unknown>): Promise<unknown> {
    const response = await room.fetch(new Request('https://internal/api/tools/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': ownerUserId,
        'X-App-Action': 'true',
      },
      body: JSON.stringify({ tool, params }),
    }))
    const result = await response.json() as { success: boolean; data?: unknown; error?: string }
    if (!result.success) {
      throw new Error(`RecordRoom tool ${tool} failed: ${result.error || 'Unknown error'}`)
    }
    return result.data
  }

  const records: CronContext['records'] = {
    async query(collection, opts) {
      const params: Record<string, unknown> = { collection }
      if (opts?.where) params.where = opts.where
      if (opts?.limit) params.limit = opts.limit
      const data = await executeTool('records.query', params)
      const records = (data as { records?: unknown[] } | null | undefined)?.records
      return records ?? []
    },
    async create(collection, data) {
      return executeTool('records.create', { collection, data })
    },
    async update(collection, recordId, data) {
      return executeTool('records.update', { collection, recordId, data })
    },
    async delete(collection, recordId) {
      return executeTool('records.delete', { collection, recordId })
    },
  }

  const integrations: CronContext['integrations'] = {
    async call(endpoint, params = {}) {
      if (!env.APP_OWNER_JWT) {
        throw new Error(
          'integrations.call requires env.APP_OWNER_JWT. Deployed apps receive ' +
            'this automatically; in dev, `deepspace dev` writes it into .dev.vars.',
        )
      }
      // The api-worker's /api/integrations route is path-shaped as
      // /:name/:endpoint. Pass the same "name/endpoint" string the
      // catalog uses (e.g. "openai/chat-completion").
      const response = await apiWorkerFetch(env, `/api/integrations/${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.APP_OWNER_JWT}`,
        },
        body: JSON.stringify(params),
      })
      // Read as text first so a non-JSON error body (e.g. a 502 from an
      // upstream gateway) still yields a useful error message instead of
      // surfacing a JSON parse failure.
      const text = await response.text()
      let result: { success?: boolean; data?: unknown; error?: string; message?: string } = {}
      try {
        result = text ? JSON.parse(text) : {}
      } catch {
        // fall through with empty `result`; the !response.ok branch below
        // will throw using the raw text as the detail.
      }
      if (!response.ok || !result.success) {
        const detail = result.message || result.error || text || `HTTP ${response.status}`
        throw new Error(`Integration call ${endpoint} failed: ${detail}`)
      }
      return result.data
    },
  }

  return { records, integrations, ownerUserId }
}
