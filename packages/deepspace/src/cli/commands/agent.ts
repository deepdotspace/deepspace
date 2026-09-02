/**
 * Stateless access to an app's locally-declared agent tools.
 *
 * This deliberately has no saved connection configuration: an app label maps
 * to its canonical DeepSpace origin and every call authenticates as the CLI's
 * current user.  Resolving the target happens before reading credentials, so
 * a typo or hostile URL can never receive a bearer token.
 */

import { createReadStream } from 'node:fs'
import { defineCommand } from 'citty'
import { mintAgentToken, loginAction } from '../auth'
import { appDomainForEnv, DEEPSPACE_ENV, type DeepSpaceEnvironment } from '../env'
import { defineDeepspaceCommand, Refusal, type CommandResult } from '../lib/command'
import { APP_NAME_RULES } from '../../server/rooms/app-name'
import { normalizeAgentTargetOrigin } from '../../server/agent-target'
import { BodyTooLargeError, readBoundedBodyText } from '../../shared/bounded-body'
import {
  AGENT_TOOL_REQUEST_BODY_CAP,
  AGENT_TOOL_RESPONSE_BODY_CAP,
} from '../../shared/agent-tool-protocol'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_INPUT_BYTES = AGENT_TOOL_REQUEST_BODY_CAP
const MAX_RESPONSE_BYTES = AGENT_TOOL_RESPONSE_BODY_CAP

export interface AgentApp {
  id: string
  name: string
}

export interface AgentTool {
  name: string
  description: string
  inputSchema: unknown
  outputSchema?: unknown
}

interface ToolsResponse {
  ok: true
  app: AgentApp
  tools: AgentTool[]
}

interface InvokeResponse {
  ok: true
  result: unknown
}

export interface AgentTarget {
  url: string
}

function badApp(message: string): never {
  throw new Refusal(message, 'invalid_agent_app')
}

/** Keep URL labels aligned with the deploy-time canonical app-name rules. */
function isCanonicalAppLabel(value: string): boolean {
  return (
    value.length >= APP_NAME_RULES.minLength &&
    value.length <= APP_NAME_RULES.maxLength &&
    APP_NAME_RULES.pattern.test(value)
  )
}

/** Resolve only canonical app origins (or loopback for local development). */
export function resolveAgentTarget(
  app: string,
  plane: DeepSpaceEnvironment = DEEPSPACE_ENV,
): AgentTarget {
  if (typeof app !== 'string' || !app)
    badApp('App must be a canonical app name or canonical app URL.')
  const appDomain = appDomainForEnv(plane)
  if (!appDomain) badApp('The selected DeepSpace environment is invalid.')

  // 'localhost' is a valid app label, so a bare `localhost` would silently
  // resolve to the PUBLIC origin localhost.<appDomain> and receive a minted
  // credential. Local development must name its loopback URL explicitly.
  if (app.toLowerCase() === 'localhost') {
    badApp("Pass an explicit loopback URL for local development (e.g. 'http://localhost:8787').")
  }

  if (isCanonicalAppLabel(app)) {
    return { url: `https://${app}.${appDomain}` }
  }

  const url = normalizeAgentTargetOrigin(app, {
    appDomain,
    allowLoopback: true,
  })
  if (!url) {
    badApp(
      'App URL must be an exact canonical app origin (or a root loopback URL for local development).',
    )
  }
  return { url }
}

export function parseAgentTimeout(raw: unknown): number {
  if (raw == null) return DEFAULT_TIMEOUT_MS
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new Refusal(
      `Invalid --timeout '${String(raw)}'. Must be a positive integer up to ${MAX_TIMEOUT_MS} milliseconds.`,
      'invalid_timeout',
    )
  }
  return value
}

function assertInputSize(value: string): void {
  if (Buffer.byteLength(value) > MAX_INPUT_BYTES) {
    throw new Refusal(`Input exceeds the ${MAX_INPUT_BYTES}-byte limit.`, 'input_too_large')
  }
}

function serializeAgentInput(input: unknown): string {
  const body = JSON.stringify({ input })
  if (Buffer.byteLength(body) > AGENT_TOOL_REQUEST_BODY_CAP) {
    throw new Refusal(
      `Tool request exceeds the ${AGENT_TOOL_REQUEST_BODY_CAP}-byte limit.`,
      'input_too_large',
    )
  }
  return body
}

/**
 * Accumulate stdin or a file stream under the input cap. Streaming (rather
 * than trusting stat() then allocating) keeps a changed or hostile file from
 * being fully read past the limit.
 */
async function readBoundedLocalInput(source: AsyncIterable<string | Buffer>): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_INPUT_BYTES) {
      throw new Refusal(`Input exceeds the ${MAX_INPUT_BYTES}-byte limit.`, 'input_too_large')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse the one JSON input argument, before authentication or networking. */
export async function resolveAgentInput(opts: {
  input?: string
  inputFile?: string
}): Promise<unknown> {
  if (opts.input != null && opts.inputFile != null) {
    throw new Refusal('Pass either --input or --input-file, not both.', 'conflicting_input_args')
  }
  let raw = '{}'
  if (opts.input != null) {
    raw = opts.input
    assertInputSize(raw)
  } else if (opts.inputFile != null) {
    if (opts.inputFile === '-') {
      raw = await readBoundedLocalInput(process.stdin)
    } else {
      try {
        raw = await readBoundedLocalInput(createReadStream(opts.inputFile))
      } catch (error) {
        if (error instanceof Refusal) throw error
        throw new Refusal(`Could not read input file '${opts.inputFile}'.`, 'input_file_unreadable')
      }
    }
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Refusal('Input is not valid JSON.', 'invalid_input_json')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validApp(value: unknown): value is AgentApp {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
}

function validTool(value: unknown): value is AgentTool {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    Object.prototype.hasOwnProperty.call(value, 'inputSchema')
  )
}

function parseToolsResponse(value: unknown): ToolsResponse {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !validApp(value.app) ||
    !Array.isArray(value.tools)
  ) {
    throw new Refusal('The app returned an unexpected tools response.', 'invalid_agent_response')
  }
  if (!value.tools.every(validTool)) {
    throw new Refusal('The app returned an invalid tool definition.', 'invalid_agent_response')
  }
  return { ok: true, app: value.app, tools: value.tools }
}

function parseInvokeResponse(value: unknown): InvokeResponse {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !Object.prototype.hasOwnProperty.call(value, 'result')
  ) {
    throw new Refusal('The app returned an unexpected tool response.', 'invalid_agent_response')
  }
  return { ok: true, result: value.result }
}

function safeServerCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : undefined
}

function redact(value: string, tokens: string[]): string {
  return tokens.reduce(
    (text, token) => (token ? text.split(token).join('[redacted]') : text),
    value,
  )
}

/** An app controls its response, so do not let a diagnostic echo our JWT. */
function redactValue(value: unknown, tokens: string[]): unknown {
  if (typeof value === 'string') return redact(value, tokens)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, tokens))
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key, tokens), redactValue(item, tokens)]),
    )
  }
  return value
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await readBoundedBodyText(response, MAX_RESPONSE_BYTES)
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      throw new Refusal(
        `App response exceeds the ${MAX_RESPONSE_BYTES}-byte limit.`,
        'response_too_large',
      )
    }
    throw error
  }
}

async function requestJson(
  url: string,
  init: RequestInit,
  token: string,
  timeout: number,
): Promise<{ status: number; body: unknown; text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    let response: Response
    try {
      response = await fetch(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${token}` },
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new Refusal(`Request timed out after ${timeout}ms.`, 'agent_timeout')
      }
      throw new Refusal('Could not reach the app agent endpoint.', 'agent_network_error')
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined)
      throw new Refusal(
        'App agent endpoint redirected; refusing to forward credentials.',
        'agent_redirect_refused',
      )
    }
    let text: string
    try {
      text = await readResponseText(response)
    } catch (error) {
      if (error instanceof Refusal) throw error
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new Refusal(`Request timed out after ${timeout}ms.`, 'agent_timeout')
      }
      throw new Refusal('Could not read the app agent response.', 'agent_network_error')
    }
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        // A non-JSON error still receives a stable HTTP refusal below; a
        // non-JSON success cannot be trusted as an agent result.
        if (response.ok)
          throw new Refusal('The app returned a non-JSON response.', 'invalid_agent_response')
      }
    }
    return { status: response.status, body, text }
  } finally {
    clearTimeout(timer)
  }
}

function httpRefusal(response: { status: number; body: unknown }, tokens: string[]): Refusal {
  const server = isRecord(response.body) ? response.body : undefined
  const code = safeServerCode(server?.code)
  const message =
    typeof server?.error === 'string' ? redact(server.error, tokens).slice(0, 500) : ''
  if (response.status === 403) {
    return new Refusal(
      message || 'You are not allowed to use this app agent.',
      code ?? 'agent_forbidden',
    )
  }
  if (response.status === 404 && !server) {
    // Two states land here and the transport cannot tell them apart: the app
    // name resolves to nothing at all, or the app exists but never deployed
    // `registerAgent`. Name both and the check for each (2026-08-28
    // agent-tools AX F4: the old sentence asserted an endpoint fact about an
    // app that did not exist).
    return new Refusal(
      'No agent endpoint answered for this app. Either the app name/id is wrong ' +
        '(`deepspace app list` shows yours), or the app does not register assistant tools — ' +
        'its worker needs `registerAgent(app, { tools, inApp: false })` deployed.',
      'agent_endpoint_not_found',
    )
  }
  return new Refusal(
    message || `App agent request failed (${response.status}).`,
    code ?? (response.status === 404 ? 'agent_endpoint_not_found' : 'agent_request_failed'),
  )
}

async function callAgent(
  target: AgentTarget,
  path: string,
  init: RequestInit,
  timeout: number,
): Promise<unknown> {
  let token = await mintAgentToken(target.url)
  const tokens = [token]
  let retried = false
  for (;;) {
    const response = await requestJson(`${target.url}${path}`, init, token, timeout)
    if (response.status !== 401) {
      if (response.status < 200 || response.status >= 300) throw httpRefusal(response, tokens)
      return redactValue(response.body, tokens)
    }
    // A server 401 can mean the short-lived token expired between minting and
    // verification. Remint and retry once; never fall back to the ordinary
    // platform bearer.
    if (!retried) {
      retried = true
      token = await mintAgentToken(target.url)
      tokens.push(token)
      continue
    }
    throw new Refusal(
      'Authentication was rejected. Run `deepspace auth login` and try again.',
      'not_authenticated',
      { action: loginAction() },
    )
  }
}

export async function runAgentTools(args: { app: string; json?: boolean }): Promise<CommandResult> {
  const target = resolveAgentTarget(args.app)
  const body = parseToolsResponse(
    await callAgent(target, '/_deepspace/agent/tools', { method: 'GET' }, DEFAULT_TIMEOUT_MS),
  )
  if (!args.json) {
    console.log(`App: ${body.app.name} (${body.app.id}, ${target.url})`)
    if (body.tools.length === 0) console.log('Tools: none')
    else {
      console.log('Tools:')
      for (const tool of body.tools) {
        console.log(`- ${tool.name}: ${tool.description}`)
        console.log(`  Input: ${JSON.stringify(tool.inputSchema)}`)
        if (tool.outputSchema !== undefined) {
          console.log(`  Output: ${JSON.stringify(tool.outputSchema)}`)
        }
      }
    }
  }
  return { data: { app: body.app, url: target.url, tools: body.tools } }
}

export async function runAgentInvoke(args: {
  app: string
  tool: string
  input?: string
  inputFile?: string
  timeout?: unknown
  json?: boolean
}): Promise<CommandResult> {
  const target = resolveAgentTarget(args.app)
  const input = await resolveAgentInput({ input: args.input, inputFile: args.inputFile })
  const tool = args.tool
  if (typeof tool !== 'string' || !tool)
    throw new Refusal('Tool name is required.', 'invalid_agent_tool')
  const requestBody = serializeAgentInput(input)
  const body = parseInvokeResponse(
    await callAgent(
      target,
      `/_deepspace/agent/tools/${encodeURIComponent(tool)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody,
      },
      parseAgentTimeout(args.timeout),
    ),
  )
  if (!args.json) {
    console.log(`App: ${args.app} (${target.url})`)
    console.log(`Tool: ${tool}`)
    console.log('Result:')
    console.log(JSON.stringify(body.result, null, 2))
  }
  return { data: { app: args.app, url: target.url, tool, result: body.result } }
}

const tools = defineDeepspaceCommand({
  meta: { name: 'tools', description: 'List the agent tools exposed by an app' },
  args: {
    app: { type: 'positional', description: 'Canonical app name or URL', required: true },
  },
  async run({ args }) {
    return runAgentTools({ app: args.app as string, json: args.json })
  },
})

const invoke = defineDeepspaceCommand({
  meta: { name: 'invoke', description: 'Invoke an agent tool exposed by an app' },
  args: {
    app: { type: 'positional', description: 'Canonical app name or URL', required: true },
    tool: { type: 'positional', description: 'Tool name', required: true },
    input: { type: 'string', description: 'Inline JSON tool input' },
    'input-file': { type: 'string', description: 'JSON input file (use - for stdin)' },
    timeout: {
      type: 'string',
      description: `Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})`,
    },
  },
  async run({ args }) {
    return runAgentInvoke({
      app: args.app as string,
      tool: args.tool as string,
      input: args.input as string | undefined,
      inputFile: args['input-file'] as string | undefined,
      timeout: args.timeout,
      json: args.json,
    })
  },
})

export default defineCommand({
  meta: { name: 'agent', description: 'List and invoke an app’s stateless local agent tools' },
  subCommands: { tools, invoke },
})
