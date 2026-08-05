export const MCP_SERVER_VERSION = '1.0.0'

export type JsonRpcId = string | number | null

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: unknown
}

export const CURRENT_PROTOCOL_VERSION = '2025-11-25'
export const SUPPORTED_PROTOCOL_VERSIONS = new Set([CURRENT_PROTOCOL_VERSION, '2025-06-18', '2025-03-26'])
export function initializeResponse(request: JsonRpcRequest & { id: JsonRpcId }): Response {
  const params = objectValue(request.params)
  const requested =
    typeof params?.protocolVersion === 'string' ? params.protocolVersion : CURRENT_PROTOCOL_VERSION
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : CURRENT_PROTOCOL_VERSION
  return mcpResult(request.id, {
    protocolVersion,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
    },
    serverInfo: {
      name: 'DeepSpace Documentation',
      title: 'DeepSpace documentation',
      version: MCP_SERVER_VERSION,
    },
    instructions:
      'Search the published documentation before answering, then read exact pages when full context is needed.',
  })
}

export function hasValidOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin')
  if (!origin) return true
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

export function parseRequest(
  raw: string,
): { ok: true; request: JsonRpcRequest } | { ok: false; message: string } {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, message: 'Invalid JSON' }
  }
  const candidate = objectValue(value)
  if (!candidate || candidate.jsonrpc !== '2.0' || typeof candidate.method !== 'string') {
    return { ok: false, message: 'Invalid JSON-RPC request' }
  }
  if (
    candidate.id !== undefined &&
    candidate.id !== null &&
    typeof candidate.id !== 'string' &&
    typeof candidate.id !== 'number'
  )
    return { ok: false, message: 'Invalid JSON-RPC id' }
  return {
    ok: true,
    request: {
      jsonrpc: '2.0',
      method: candidate.method,
      ...(candidate.id !== undefined ? { id: candidate.id as JsonRpcId } : {}),
      ...(candidate.params !== undefined ? { params: candidate.params } : {}),
    },
  }
}

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function toolResult(id: JsonRpcId, value: Record<string, unknown>): Response {
  return mcpResult(id, {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  })
}

export function toolError(id: JsonRpcId, message: string): Response {
  return mcpResult(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  })
}

export function mcpResult(id: JsonRpcId, result: unknown): Response {
  return jsonResponse({ jsonrpc: '2.0', id, result })
}

export function mcpError(
  id: JsonRpcId,
  code: number,
  message: string,
  status = 200,
  headers?: HeadersInit,
): Response {
  return jsonResponse({ jsonrpc: '2.0', id, error: { code, message } }, status, headers)
}

export function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...mcpSecurityHeaders(),
      ...headers,
    },
  })
}

export function mcpSecurityHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }
}
