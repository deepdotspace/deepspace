/**
 * Composio tools for the Vercel AI SDK.
 *
 * Turns the platform's Composio integration into ready-to-use Vercel AI SDK
 * tools, so an agent (or the DeepSpace AI chat) can take actions on a user's
 * connected apps. Each returned tool's `execute()` calls our own
 * `composio/execute-tool` endpoint through the api-worker proxy, so our auth
 * and per-user billing apply. This is the managed-proxy equivalent of
 * Composio's `@composio/vercel` provider, which talks straight to Composio.
 *
 * Every call carries the app's identity, so it reaches the connections users
 * made inside this app (the same ones the browser connect flow creates). Who
 * the call runs as is the `ComposioCaller`:
 *   - `authToken`: the signed-in user's JWT. Runs as them and bills them.
 *   - `asUser`: a user id, for the app's own server code with no user request
 *     in hand (e.g. a cron job). Runs as that user on the connections they made
 *     in this app, billed to the app owner via APP_OWNER_JWT.
 *
 * Usage (inside a request handler, e.g. /api/ai/chat):
 *
 *   import { composioTools, createDeepSpaceAI } from 'deepspace/worker'
 *   const jwt = c.req.header('Authorization')!.slice(7)
 *   const tools = await composioTools(c.env, { toolkit: 'gmail', authToken: jwt })
 *   const ai = createDeepSpaceAI(c.env, 'anthropic', { authToken: jwt })
 *   const result = streamText({ model: ai('claude-sonnet-5-5'), prompt, tools })
 *
 * Merge with your own tools: `tools: { ...buildTools(executor), ...composio }`.
 *
 * Without an LLM (e.g. an hourly cron reading each user's inbox):
 *
 *   const data = await callComposio(env, 'execute-tool',
 *     { slug: 'GMAIL_FETCH_EMAILS', arguments: { max_results: 10 } }, { asUser: userId })
 */

import { tool, jsonSchema, type ToolSet } from 'ai'
import { apiWorkerFetch, type ApiWorkerEnv } from './proxies'
import { appendAppIdentity, type AppIdentityEnv } from './app-identity'
import { integrationPath } from './integration-path'

export interface ComposioEnv extends ApiWorkerEnv, AppIdentityEnv {
  /** Bills `asUser` calls to the app owner. Injected at deploy time. */
  APP_OWNER_JWT?: string
}

/** Who a Composio call runs as (and who pays). */
export type ComposioCaller =
  /** The signed-in user's JWT: runs as that user and bills them. */
  | { authToken: string; asUser?: never }
  /** A user id, from the app's own server code: runs as that user on the
   *  connections they made in this app, billed to the app owner. */
  | { asUser: string; authToken?: never }

export type ComposioToolsOptions = ComposioCaller & {
  /** Restrict to one toolkit (e.g. 'gmail', 'github'). */
  toolkit?: string
  /** Explicit tool slugs to expose (e.g. ['GMAIL_SEND_EMAIL']). */
  tools?: string[]
  /** Natural-language search to pick relevant tools. */
  search?: string
  /** Cap how many tools are exposed (default 20). Keep small: the LLM sees them all. */
  limit?: number
}

interface ComposioToolItem {
  slug: string
  name?: string
  description?: string
  input_parameters?: Record<string, unknown>
}

const EMPTY_SCHEMA = { type: 'object', properties: {} }

function composioHeaders(env: ComposioEnv, caller: ComposioCaller): Headers {
  // A blank id would be dropped in transit and the call would run as the owner.
  if (caller.asUser !== undefined && !caller.asUser.trim()) {
    throw new Error('Composio asUser must be a user id.')
  }
  const token = caller.asUser ? env.APP_OWNER_JWT : caller.authToken
  if (!token) {
    throw new Error(
      caller.asUser
        ? 'Composio asUser calls need env.APP_OWNER_JWT (injected at deploy time; ' +
            '`deepspace dev start` writes it into .dev.vars).'
        : "Composio calls need a caller: authToken (the signed-in user's JWT) or " +
            'asUser (a user id, from server code).',
    )
  }
  const headers = new Headers({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` })
  appendAppIdentity(headers, env)
  if (caller.asUser) headers.set('x-act-as-user', caller.asUser)
  return headers
}

/** POST a Composio endpoint through the api-worker proxy and parse the
 *  `{ success, data }` envelope. Text-first so a non-JSON gateway error still
 *  yields a useful detail string instead of a parse failure. Upstream refusals
 *  come back in the envelope; a bad caller or a network failure throws. */
async function requestComposio(
  env: ComposioEnv,
  endpoint: string,
  params: Record<string, unknown>,
  caller: ComposioCaller,
): Promise<{ ok: boolean; success: boolean; data: unknown; detail: string }> {
  // A plain identifier only: `../..` would carry the owner's token elsewhere.
  const path = integrationPath('composio', endpoint)
  if (!path) throw new Error(`Composio endpoint ${JSON.stringify(endpoint)} must be a plain identifier.`)
  const res = await apiWorkerFetch(env, path, {
    method: 'POST',
    headers: composioHeaders(env, caller),
    body: JSON.stringify(params),
  })
  const text = await res.text()
  let parsed: { success?: boolean; data?: unknown; error?: string; message?: string } = {}
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    // non-JSON body; detail falls back to the raw text below
  }
  const detail = parsed.message || parsed.error || text || `HTTP ${res.status}`
  return { ok: res.ok, success: parsed.success === true, data: parsed.data, detail }
}

/**
 * Call one Composio endpoint (e.g. 'execute-tool', 'list-connections') and
 * return its `data`. Throws on failure. A user who has not connected the
 * tool's app comes back as `{ requiresConnection: true, toolkit }`, not an error.
 */
export async function callComposio(
  env: ComposioEnv,
  endpoint: string,
  params: Record<string, unknown>,
  caller: ComposioCaller,
): Promise<unknown> {
  const r = await requestComposio(env, endpoint, params, caller)
  if (!r.ok || !r.success) throw new Error(`Composio ${endpoint} failed: ${r.detail}`)
  return r.data
}

/** Composio slugs are already valid tool-name chars; sanitize + cap at 64 only
 *  as a guard (Anthropic rejects longer names). The real slug is always used
 *  for execution regardless of the key. */
function toolKey(slug: string): string {
  const key = slug.replace(/[^a-zA-Z0-9_-]/g, '_')
  return key.length <= 64 ? key : key.slice(0, 64)
}

/**
 * Fetch Composio tools for the given scope and return them as a Vercel AI SDK
 * `ToolSet`. One `list-tools` call provides each tool's JSON Schema; each tool
 * executes via `composio/execute-tool` as the options' caller.
 */
export async function composioTools(
  env: ComposioEnv,
  options: ComposioToolsOptions,
): Promise<ToolSet> {
  const list = await requestComposio(
    env,
    'list-tools',
    {
      toolkit: options.toolkit,
      toolSlugs: options.tools?.length ? options.tools.join(',') : undefined,
      search: options.search,
      limit: options.limit ?? 20,
    },
    options,
  )
  if (!list.ok || !list.success) {
    throw new Error(`composioTools: failed to list Composio tools: ${list.detail}`)
  }

  const listItems = (list.data as { items?: unknown } | undefined)?.items
  const items: ComposioToolItem[] = Array.isArray(listItems) ? (listItems as ComposioToolItem[]) : []
  const tools: ToolSet = {}

  for (const item of items) {
    if (!item?.slug) continue
    const slug = item.slug
    const schema = (item.input_parameters ?? EMPTY_SCHEMA) as Parameters<typeof jsonSchema>[0]

    tools[toolKey(slug)] = tool({
      description: item.description ?? item.name ?? slug,
      inputSchema: jsonSchema(schema),
      execute: async (args: Record<string, unknown>) => {
        const r = await requestComposio(
          env,
          'execute-tool',
          { slug, arguments: args ?? {} },
          options,
        )
        if (!r.ok || !r.success) {
          // Surface a readable error to the model instead of throwing, so the
          // agent loop can recover or explain to the user.
          return { error: true, message: `Composio tool ${slug} failed: ${r.detail}` }
        }
        const data = r.data
        if (data && typeof data === 'object' && (data as { requiresConnection?: boolean }).requiresConnection) {
          const toolkit = (data as { toolkit?: string }).toolkit
          return {
            requiresConnection: true,
            toolkit,
            message: `The user has not connected ${toolkit ?? 'this app'}. Ask them to connect it before using this tool.`,
          }
        }
        return data
      },
    })
  }

  return tools
}
