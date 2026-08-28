/**
 * Authenticated local-assistant tool routes for generated DeepSpace apps.
 *
 * The generated worker owns authentication policy; this SDK registrar only
 * consumes its verified access decision and executes the app's existing AI SDK
 * tools as that verified user.
 */

import { asSchema, type ToolSet } from 'ai'
import type { Hono } from 'hono'
import type { VerifyResult } from './auth/types'
import { DEFAULT_CONTEXT_CONFIG, capToolResultSize, utf8ByteLength } from './utils/chat-context'
import { BodyTooLargeError, readBoundedBodyText } from '../shared/bounded-body'
import {
  AGENT_TOOL_REQUEST_BODY_CAP,
  AGENT_TOOL_RESPONSE_BODY_CAP,
} from '../shared/agent-tool-protocol'

export { AGENT_TOOL_REQUEST_BODY_CAP, AGENT_TOOL_RESPONSE_BODY_CAP }

export interface AgentToolRouteEnv {
  APP_NAME: string
  DEEPSPACE_APP_ID: string
  RECORD_ROOMS: DurableObjectNamespace
}

/**
 * The generated worker distinguishes a missing identity (401), a denied
 * identity (403), and an access check it could not complete (503) — a
 * transient failure must not present as a permanent permission denial.
 */
export type AgentToolAccessResult =
  | { ok: true; auth: VerifyResult }
  | { ok: false; status: 401 | 403 | 503 }

export interface AgentToolRouteOptions<Env extends AgentToolRouteEnv> {
  /** Preserve the generated app's existing tool definitions unchanged. */
  buildTools: (
    executor: (toolName: string, params: Record<string, unknown>) => Promise<unknown>,
  ) => ToolSet
  /** Performs app-specific authentication and authorization before tool discovery or execution. */
  resolveAccess: (request: Request, env: Env) => Promise<AgentToolAccessResult>
}

type JsonRecord = Record<string, unknown>

interface AgentToolRequestBody {
  input: unknown
}

type ServerExecutableTool = ToolSet[string] & {
  execute: NonNullable<ToolSet[string]['execute']>
}

function jsonResponse(body: unknown, status = 200): Response {
  return rawJsonResponse(JSON.stringify(body), status)
}

function rawJsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  })
}

function errorResponse(
  status: 400 | 401 | 403 | 404 | 413 | 500 | 503,
  code:
    | 'unauthenticated'
    | 'forbidden'
    | 'access_check_unavailable'
    | 'tool_not_found'
    | 'invalid_json'
    | 'invalid_tool_input'
    | 'payload_too_large'
    | 'tool_configuration_error'
    | 'tool_execution_failed'
    | 'invalid_tool_result'
    | 'tool_result_too_large',
): Response {
  const errors = {
    unauthenticated: 'Authentication is required.',
    forbidden: 'You are not allowed to use assistant tools.',
    access_check_unavailable: 'Access could not be verified. Try again.',
    tool_not_found: 'The requested tool is not available.',
    invalid_json: 'The request body must be valid JSON.',
    invalid_tool_input: 'The tool input is invalid.',
    payload_too_large: 'The request body is too large.',
    tool_configuration_error: 'Assistant tools are not configured correctly.',
    tool_execution_failed: 'The tool could not be executed.',
    invalid_tool_result: 'The tool returned an invalid result.',
    tool_result_too_large: 'The tool returned a result that is too large.',
  } as const
  return jsonResponse({ ok: false, code, error: errors[code] }, status)
}

function parseToolRequestBody(text: string): AgentToolRequestBody | null | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (!Object.hasOwn(parsed, 'input')) return null
  return { input: (parsed as JsonRecord).input }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    Symbol.asyncIterator in value
  )
}

function jsonText(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? serialized : undefined
  } catch {
    return undefined
  }
}

function executableTool(tools: ToolSet, name: string): ServerExecutableTool | undefined {
  if (!Object.hasOwn(tools, name)) return undefined
  const tool = tools[name]
  return typeof tool.execute === 'function' ? { ...tool, execute: tool.execute } : undefined
}

function toolMetadata(tools: ToolSet) {
  return Object.entries(tools)
    .flatMap(([name, tool]) => {
      if (typeof tool.execute !== 'function') return []
      const inputSchema = asSchema(tool.inputSchema)
      const entry: {
        name: string
        description: string
        inputSchema: unknown
        outputSchema?: unknown
      } = {
        name,
        description: typeof tool.description === 'string' ? tool.description : '',
        inputSchema: inputSchema.jsonSchema,
      }
      if (tool.outputSchema) entry.outputSchema = asSchema(tool.outputSchema).jsonSchema
      return [entry]
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

export interface UserToolExecutorEnv {
  DEEPSPACE_APP_ID: string
  RECORD_ROOMS: DurableObjectNamespace
}

/**
 * Execute one app tool in the canonical app RecordRoom as the verified user.
 * Every assistant surface (website chat, local agent) must share this path so
 * a tool behaves identically regardless of which surface invoked it.
 */
export function createUserToolExecutor(
  env: UserToolExecutorEnv,
  userId: string,
  signal: AbortSignal,
): (toolName: string, params: Record<string, unknown>) => Promise<unknown> {
  const roomId = env.RECORD_ROOMS.idFromName(`app:${env.DEEPSPACE_APP_ID}`)
  const room = env.RECORD_ROOMS.get(roomId)
  return async (toolName: string, params: Record<string, unknown>): Promise<unknown> => {
    const response = await room.fetch(
      new Request('https://internal/api/tools/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': userId,
        },
        body: JSON.stringify({ tool: toolName, params }),
        signal,
      }),
    )
    return capToolResultSize(await response.json(), DEFAULT_CONTEXT_CONFIG.toolResultCap)
  }
}

/** Shared route preamble: verify access, then build the caller-scoped tools. */
async function resolveCallerTools<Env extends AgentToolRouteEnv>(
  options: AgentToolRouteOptions<Env>,
  request: Request,
  env: Env,
): Promise<ToolSet | Response> {
  let access: AgentToolAccessResult
  try {
    access = await options.resolveAccess(request, env)
  } catch {
    return errorResponse(500, 'tool_configuration_error')
  }
  if (!access.ok) {
    return errorResponse(
      access.status,
      access.status === 401
        ? 'unauthenticated'
        : access.status === 403
          ? 'forbidden'
          : 'access_check_unavailable',
    )
  }
  try {
    return options.buildTools(createUserToolExecutor(env, access.auth.userId, request.signal))
  } catch {
    return errorResponse(500, 'tool_configuration_error')
  }
}

/**
 * Register the generated app's local assistant tool API.
 *
 * Mount before a broad `/_deepspace/*` proxy route so these SDK-owned paths
 * stay in the app Worker and retain the verified caller identity.
 */
export function registerAgentToolRoutes<Env extends AgentToolRouteEnv>(
  app: Hono<{ Bindings: Env }>,
  options: AgentToolRouteOptions<Env>,
): void {
  app.get('/_deepspace/agent/tools', async (c) => {
    const tools = await resolveCallerTools(options, c.req.raw, c.env)
    if (tools instanceof Response) return tools

    try {
      const serialized = jsonText({
        ok: true,
        app: { id: c.env.DEEPSPACE_APP_ID, name: c.env.APP_NAME },
        tools: toolMetadata(tools),
      })
      if (!serialized || utf8ByteLength(serialized) > AGENT_TOOL_RESPONSE_BODY_CAP) {
        return errorResponse(500, 'tool_configuration_error')
      }
      return rawJsonResponse(serialized)
    } catch {
      return errorResponse(500, 'tool_configuration_error')
    }
  })

  app.post('/_deepspace/agent/tools/:name', async (c) => {
    const tools = await resolveCallerTools(options, c.req.raw, c.env)
    if (tools instanceof Response) return tools

    let tool: ServerExecutableTool | undefined
    try {
      tool = executableTool(tools, c.req.param('name'))
    } catch {
      return errorResponse(500, 'tool_configuration_error')
    }
    if (!tool) return errorResponse(404, 'tool_not_found')

    let text: string
    try {
      text = await readBoundedBodyText(c.req.raw, AGENT_TOOL_REQUEST_BODY_CAP)
    } catch (error) {
      return error instanceof BodyTooLargeError
        ? errorResponse(413, 'payload_too_large')
        : errorResponse(400, 'invalid_json')
    }
    const body = parseToolRequestBody(text)
    if (body === undefined) return errorResponse(400, 'invalid_json')
    if (body === null) return errorResponse(400, 'invalid_tool_input')

    let input = body.input
    try {
      const validation = asSchema(tool.inputSchema).validate
      if (validation) {
        const result = await validation(input)
        if (!result.success) return errorResponse(400, 'invalid_tool_input')
        input = result.value
      }
    } catch {
      return errorResponse(400, 'invalid_tool_input')
    }

    let output: unknown
    try {
      output = await tool.execute(input, {
        toolCallId: crypto.randomUUID(),
        messages: [],
        abortSignal: c.req.raw.signal,
      })
    } catch {
      return errorResponse(500, 'tool_execution_failed')
    }
    if (isAsyncIterable(output)) return errorResponse(500, 'invalid_tool_result')

    try {
      if (tool.outputSchema) {
        const validation = asSchema(tool.outputSchema).validate
        if (validation) {
          const result = await validation(output)
          if (!result.success) return errorResponse(500, 'invalid_tool_result')
          output = result.value
        }
      }
    } catch {
      return errorResponse(500, 'invalid_tool_result')
    }

    // A side-effect-only tool legitimately returns undefined; its REST result
    // is null. Functions/symbols/cyclic values still refuse below.
    const serialized = jsonText(output === undefined ? null : output)
    if (!serialized) return errorResponse(500, 'invalid_tool_result')
    if (utf8ByteLength(serialized) > DEFAULT_CONTEXT_CONFIG.toolResultCap) {
      return errorResponse(500, 'tool_result_too_large')
    }
    return rawJsonResponse(`{"ok":true,"result":${serialized}}`)
  })

  // Keep unsupported local-assistant paths inside the app instead of letting
  // a later broad `/_deepspace/*` platform proxy claim them.
  app.all('/_deepspace/agent', () => errorResponse(404, 'tool_not_found'))
  app.all('/_deepspace/agent/*', () => errorResponse(404, 'tool_not_found'))
}
