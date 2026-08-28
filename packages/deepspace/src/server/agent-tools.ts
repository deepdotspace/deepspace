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
  /** Appended to the base sentence — the stated cause an exit-1 caller is
   *  told to fix (2026-08-28 agent-tools AX F1: "The tool input is invalid."
   *  named no field, no type, nothing to diff against). */
  detail?: string,
): Response {
  const errors = {
    unauthenticated: 'Authentication is required.',
    // The remedy is documented and single-step (local-agent-tools.md): a
    // signed-in app visit creates or refreshes the caller's user row.
    forbidden:
      'You are not allowed to use assistant tools. Sign in to the app once in a browser ' +
      '(a signed-in visit creates your user row), or ask the app owner for access.',
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
  const error = detail ? `${errors[code]} ${detail}` : errors[code]
  return jsonResponse({ ok: false, code, error }, status)
}

/** One bounded line of a validator's own diagnosis, so the refusal states
 *  the cause instead of only asserting one exists. A zod error's `message`
 *  is a raw JSON dump of its issues — render those as `path: message` lines
 *  instead, with an explicit count when some are elided, so a multi-field
 *  mistake never silently loses its tail to truncation. */
function validationDetail(error: unknown): string | undefined {
  const issues = (error as { issues?: unknown }).issues
  if (Array.isArray(issues) && issues.length > 0) {
    const shown = issues.slice(0, 5).map((issue) => {
      const { path, message } = (issue ?? {}) as { path?: unknown; message?: unknown }
      const at = Array.isArray(path) && path.length > 0 ? `${path.join('.')}: ` : ''
      return `${at}${typeof message === 'string' ? message : 'invalid'}`
    })
    const more = issues.length - shown.length
    return `${shown.join('; ')}${more > 0 ? ` (+${more} more)` : ''}`
  }
  if (!(error instanceof Error) || !error.message) return undefined
  const line = error.message.replace(/\s+/g, ' ').trim()
  return line.length > 400 ? `${line.slice(0, 400)}…` : line
}

/** Top-level keys the validator silently DROPPED from a schema whose
 *  published contract is closed (`additionalProperties: false`). Runtime
 *  truth decides: open schemas keep their extra keys and return none here.
 *  Failures to read the lazy `jsonSchema` (unrepresentable schemas) mean no
 *  published contract to enforce — return none. */
function droppedTopLevelKeys(
  schema: { jsonSchema: unknown },
  input: unknown,
  validated: unknown,
): string[] {
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    validated === null ||
    typeof validated !== 'object' ||
    Array.isArray(validated)
  ) {
    return []
  }
  try {
    // Accessed HERE so the lazy getter's throw stays inside this try.
    const jsonSchema = schema.jsonSchema as
      | { type?: unknown; additionalProperties?: unknown }
      | undefined
    if (jsonSchema?.type !== 'object' || jsonSchema.additionalProperties !== false) return []
  } catch {
    return []
  }
  return Object.keys(input).filter((key) => !Object.hasOwn(validated, key))
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
    if (!tool) {
      // Name what IS available: this absorbs both a plain typo and the
      // dotted-vs-underscored separator confusion (2026-08-28 agent-tools AX
      // F5 — prose elsewhere says `records.update`, discovery says
      // `records_update`) without the caller needing a second discovery call.
      const names = Object.keys(tools)
        .filter((name) => typeof tools[name]?.execute === 'function')
        .sort()
      const listed = names.slice(0, 20).join(', ')
      return errorResponse(
        404,
        'tool_not_found',
        names.length > 0
          ? `Available tools: ${listed}${names.length > 20 ? ', …' : ''}.`
          : undefined,
      )
    }

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
    const schema = asSchema(tool.inputSchema)
    try {
      const validation = schema.validate
      if (validation) {
        const result = await validation(input)
        if (!result.success) {
          return errorResponse(400, 'invalid_tool_input', validationDetail(result.error))
        }
        // The PUBLISHED contract says `additionalProperties: false`, but
        // zod's runtime default STRIPS unknown keys — so a typo'd argument
        // validated and reported success under the defaults (2026-08-28
        // agent-tools AX F2: `{"limitt":99}` succeeded silently). Refuse a
        // key the validator DROPPED, named — runtime truth, so deliberately
        // open schemas (`.passthrough()`, `.catchall()`) whose converted
        // jsonSchema falsely reads closed keep their extra keys and pass.
        // Gated on the published closed-ness so reshaping schemas
        // (transforms) are exempt; the helper contains the lazy jsonSchema
        // getter's possible throw (unrepresentable schemas enforce nothing).
        const dropped = droppedTopLevelKeys(schema, input, result.value)
        if (dropped.length > 0) {
          return errorResponse(
            400,
            'invalid_tool_input',
            `Unknown input field(s): ${dropped.join(', ')} — the tool's inputSchema lists the accepted fields.`,
          )
        }
        input = result.value
      }
    } catch (error) {
      return errorResponse(400, 'invalid_tool_input', validationDetail(error))
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
