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
 * `authToken` must be the END USER's JWT: Composio resolves the user's
 * connected accounts by the JWT subject, and that user is billed.
 *
 * Usage (inside a request handler, e.g. /api/ai/chat):
 *
 *   import { composioTools, createDeepSpaceAI } from 'deepspace/worker'
 *   const jwt = c.req.header('Authorization')!.slice(7)
 *   const tools = await composioTools(c.env, { toolkit: 'gmail', authToken: jwt })
 *   const ai = createDeepSpaceAI(c.env, 'anthropic', { authToken: jwt })
 *   const result = streamText({ model: ai('claude-sonnet-5'), prompt, tools })
 *
 * Merge with your own tools: `tools: { ...buildTools(executor), ...composio }`.
 */

import { tool, jsonSchema, type ToolSet } from 'ai'
import { apiWorkerFetch, type ApiWorkerEnv } from './proxies'

export interface ComposioToolsOptions {
  /** End user's JWT. Required: the tools run as this user and bill them. */
  authToken: string
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

/** POST a Composio endpoint through the api-worker proxy and parse the
 *  `{ success, data }` envelope. Text-first so a non-JSON gateway error still
 *  yields a useful detail string instead of a parse failure. Never throws. */
async function requestComposio(
  env: ApiWorkerEnv,
  endpoint: string,
  params: Record<string, unknown>,
  authToken: string,
): Promise<{ ok: boolean; success: boolean; data: unknown; detail: string }> {
  const res = await apiWorkerFetch(env, `/api/integrations/composio/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
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
 * executes via `composio/execute-tool` as the authenticated user.
 */
export async function composioTools(
  env: ApiWorkerEnv,
  options: ComposioToolsOptions,
): Promise<ToolSet> {
  const { authToken } = options
  if (!authToken) {
    throw new Error(
      'composioTools: options.authToken is required. Pass the end user\'s JWT so the ' +
        'tools run as that user (Composio resolves their connected accounts by it) and ' +
        'the calls are billed to them.',
    )
  }

  const list = await requestComposio(
    env,
    'list-tools',
    {
      toolkit: options.toolkit,
      toolSlugs: options.tools?.length ? options.tools.join(',') : undefined,
      search: options.search,
      limit: options.limit ?? 20,
    },
    authToken,
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
          authToken,
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
