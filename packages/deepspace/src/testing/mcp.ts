/**
 * `deepspace/testing/mcp` — dependency-free JSON-RPC client for exercising
 * the documentation MCP endpoint over its real HTTP wire contract.
 *
 * The endpoint is JSON-only (never SSE), stateless (no session ids), and
 * unauthenticated, so the client is plain `fetch`: incrementing request ids,
 * the negotiated `MCP-Protocol-Version` echoed after `initialize`, JSON-RPC
 * error objects surfaced as typed throws, and notifications resolved on the
 * wire's 202 + null body. It must stay importable without `@playwright/test`,
 * so it lives beside — never inside — `./index.ts`.
 */

export interface McpTestClientOptions {
  /** Endpoint path resolved against the base URL. */
  endpoint?: string
  /** Fetch implementation, e.g. one bound to an in-process worker. */
  fetch?: typeof fetch
}

export interface McpInitializeResult {
  protocolVersion: string
  capabilities: Record<string, unknown>
  serverInfo: { name: string; version: string; title?: string }
  instructions?: string
}

export interface McpTool {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpToolCallResult {
  content: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export interface McpTestClient {
  /** Negotiated at `initialize`; writable so suites can force a wire mismatch. */
  protocolVersion: string | undefined
  initialize(params?: Record<string, unknown>): Promise<McpInitializeResult>
  listTools(): Promise<McpTool[]>
  callTool(name: string, args?: Record<string, unknown>): Promise<McpToolCallResult>
  notify(method: string, params?: Record<string, unknown>): Promise<void>
}

/** A JSON-RPC `error` object answered by the endpoint. */
export class McpRpcError extends Error {
  readonly code: number
  readonly data: unknown
  readonly status: number
  constructor(status: number, error: { code: number; message: string; data?: unknown }) {
    super(error.message)
    this.name = 'McpRpcError'
    this.code = error.code
    this.data = error.data
    this.status = status
  }
}

/** A response outside the JSON-RPC contract, e.g. an unpublished surface's 404 page. */
export class McpTransportError extends Error {
  readonly status: number
  readonly bodyHead: string
  constructor(status: number, body: string) {
    const bodyHead = body.slice(0, 200)
    super(`Unexpected MCP response (HTTP ${status}): ${bodyHead || '<empty body>'}`)
    this.name = 'McpTransportError'
    this.status = status
    this.bodyHead = bodyHead
  }
}

export function createMcpTestClient(
  baseUrl: string,
  options: McpTestClientOptions = {},
): McpTestClient {
  const endpoint = new URL(options.endpoint ?? '/mcp', baseUrl).toString()
  const fetchImpl = options.fetch ?? fetch
  let nextId = 1
  let protocolVersion: string | undefined

  const post = (payload: Record<string, unknown>): Promise<Response> =>
    fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // The header exists only after negotiation, so `initialize` never carries it.
        ...(protocolVersion !== undefined && payload.method !== 'initialize'
          ? { 'MCP-Protocol-Version': protocolVersion }
          : {}),
      },
      body: JSON.stringify(payload),
    })

  const parseMessage = async (
    response: Response,
  ): Promise<{ body: string; message: Record<string, unknown> }> => {
    const body = await response.text()
    let message: unknown
    try {
      message = JSON.parse(body)
    } catch {
      throw new McpTransportError(response.status, body)
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new McpTransportError(response.status, body)
    }
    const { error } = message as { error?: { code: number; message: string; data?: unknown } }
    if (error) throw new McpRpcError(response.status, error)
    return { body, message: message as Record<string, unknown> }
  }

  const request = async <Result>(method: string, params?: unknown): Promise<Result> => {
    const response = await post({
      jsonrpc: '2.0',
      id: nextId++,
      method,
      ...(params !== undefined ? { params } : {}),
    })
    return (await parseMessage(response)).message.result as Result
  }

  return {
    get protocolVersion() {
      return protocolVersion
    },
    set protocolVersion(value) {
      protocolVersion = value
    },
    async initialize(params) {
      const result = await request<McpInitializeResult>('initialize', params)
      protocolVersion =
        typeof result?.protocolVersion === 'string' ? result.protocolVersion : undefined
      return result
    },
    async listTools() {
      return (await request<{ tools: McpTool[] }>('tools/list')).tools
    },
    async callTool(name, args = {}) {
      return request<McpToolCallResult>('tools/call', { name, arguments: args })
    },
    async notify(method, params) {
      const response = await post({
        jsonrpc: '2.0',
        method,
        ...(params !== undefined ? { params } : {}),
      })
      if (response.status === 202) return
      // Anything else breaches the notification contract: a JSON-RPC error
      // throws typed above, and a stray result is itself a transport fault.
      const { body } = await parseMessage(response)
      throw new McpTransportError(response.status, body)
    },
  }
}
