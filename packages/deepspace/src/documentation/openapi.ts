import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, extname, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  DocumentationError,
  type DocumentationOpenApiConfig,
  type DocumentationOpenApiOperation,
  type DocumentationOpenApiParameter,
} from './types'
import { slugify } from './markdown'
import { normalizeRoute } from './routing'
import { errorMessage } from './text'
import { createOpenApiCodeSamples } from './openapi-samples'
import { asOpenApiObject, resolveOpenApiObject } from './openapi-object'

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'] as const

interface OpenApiDocument {
  openapi?: unknown
  swagger?: unknown
  info?: { title?: unknown; description?: unknown }
  servers?: Array<{ url?: unknown }>
  host?: unknown
  basePath?: unknown
  schemes?: unknown
  security?: unknown
  paths?: Record<string, Record<string, unknown>>
}

export interface ParsedOpenApi {
  sourcePath: string
  title: string
  route: string
  raw: string
  operations: DocumentationOpenApiOperation[]
}

export function parseOpenApi(appDir: string, config: DocumentationOpenApiConfig): ParsedOpenApi {
  const sourcePath = resolve(appDir, config.source)
  assertOpenApiSourcePath(appDir, sourcePath, config.source)
  if (!existsSync(sourcePath)) {
    throw new DocumentationError(`OpenAPI source not found: ${config.source}`, 'documentation_openapi_missing', [
      { code: 'openapi_missing', message: config.source, file: sourcePath },
    ])
  }
  assertOpenApiSourcePath(appDir, realpathSync(sourcePath), config.source)
  const raw = readFileSync(sourcePath, 'utf8')
  let parsed: unknown
  try {
    parsed = ['.yaml', '.yml'].includes(extname(sourcePath).toLowerCase())
      ? parseYaml(raw, { maxAliasCount: 50 })
      : JSON.parse(raw)
  } catch (error) {
    throw new DocumentationError(
      `Invalid OpenAPI document ${config.source}: ${errorMessage(error)}`,
      'documentation_openapi_invalid',
      [{ code: 'openapi_parse', message: errorMessage(error), file: sourcePath }],
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidOpenApi(sourcePath, 'Document root must be an object')
  }
  const document = parsed as OpenApiDocument
  if (typeof document.openapi !== 'string' && typeof document.swagger !== 'string') {
    throw invalidOpenApi(sourcePath, 'Expected an openapi or swagger version field')
  }
  if (!document.paths || typeof document.paths !== 'object') {
    throw invalidOpenApi(sourcePath, 'Expected a paths object')
  }

  const documentServer = firstServerUrl(document.servers) ?? swaggerServerUrl(document)
  const operations: DocumentationOpenApiOperation[] = []
  const ids = new Set<string>()
  for (const [path, pathItem] of Object.entries(document.paths)) {
    const normalizedPathItem = resolveOpenApiObject(pathItem, document as Record<string, unknown>)
    if (!normalizedPathItem) continue
    for (const method of HTTP_METHODS) {
      const operation = resolveOpenApiObject(
        normalizedPathItem[method],
        document as Record<string, unknown>,
      )
      if (!operation) continue
      const baseUrl =
        config.baseUrl ??
        firstServerUrl(operation.servers) ??
        firstServerUrl(normalizedPathItem.servers) ??
        documentServer
      const fallbackId = `${method}-${path}`
      const operationId = slugify(
        typeof operation.operationId === 'string' ? operation.operationId : fallbackId,
      )
      if (!operationId)
        throw invalidOpenApi(sourcePath, `Could not derive id for ${method} ${path}`)
      if (ids.has(operationId)) {
        throw invalidOpenApi(sourcePath, `Duplicate operation id: ${operationId}`)
      }
      ids.add(operationId)
      const summary =
        typeof operation.summary === 'string'
          ? operation.summary
          : `${method.toUpperCase()} ${path}`
      const parameters = mergeParameters(
        normalizedPathItem.parameters,
        operation.parameters,
        document as Record<string, unknown>,
      )
      const security = 'security' in operation ? operation.security : document.security
      const normalized = {
        method: method.toUpperCase(),
        path,
        operationId,
        summary,
        ...(typeof operation.description === 'string'
          ? { description: operation.description }
          : {}),
        tags: Array.isArray(operation.tags)
          ? operation.tags.filter((tag): tag is string => typeof tag === 'string')
          : [],
        parameters,
        ...('requestBody' in operation ? { requestBody: operation.requestBody } : {}),
        responses: normalizeResponses(operation.responses, document as Record<string, unknown>),
        ...(security === undefined ? {} : { security }),
        ...(baseUrl ? { baseUrl } : {}),
        playground: config.playground === true && Boolean(baseUrl),
      } satisfies Omit<DocumentationOpenApiOperation, 'codeSamples'>
      operations.push({
        ...normalized,
        codeSamples: createOpenApiCodeSamples(
          normalized,
          document as Record<string, unknown>,
          config.examples,
          operation['x-codeSamples'] ?? operation['x-code-samples'],
        ),
      })
    }
  }
  if (operations.length === 0) {
    throw invalidOpenApi(sourcePath, 'No HTTP operations found')
  }

  const route = normalizeRoute(config.route ?? '/api-reference')
  const title =
    config.label ??
    (typeof document.info?.title === 'string'
      ? document.info.title
      : basename(config.source, extname(config.source)))
  return { sourcePath, title, route, raw, operations }
}

function assertOpenApiSourcePath(appDir: string, sourcePath: string, configured: string): void {
  const sourceIsReal = existsSync(sourcePath)
  const root =
    sourceIsReal && existsSync(appDir) && sourcePath === realpathSync(sourcePath)
      ? realpathSync(appDir)
      : resolve(appDir)
  const rel = relative(root, sourcePath)
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel === '') {
    throw new DocumentationError(
      `OpenAPI source must be a file inside the app directory: ${configured}`,
      'documentation_openapi_path_invalid',
      [{ code: 'openapi_path_escape', message: configured, file: sourcePath }],
    )
  }
}

export function operationMarkdown(operation: DocumentationOpenApiOperation): string {
  const lines = [
    `<div class="documentation-api-badge"><span class="method method-${operation.method.toLowerCase()}">${operation.method}</span><code>${operation.path}</code></div>`,
    '',
  ]
  if (operation.description) lines.push(operation.description, '')
  if (operation.parameters.length > 0) {
    lines.push(
      '## Parameters',
      '',
      '| Name | In | Required | Description |',
      '| --- | --- | --- | --- |',
    )
    for (const parameter of operation.parameters) {
      lines.push(
        `| \`${escapeTable(parameter.name)}\` | ${escapeTable(parameter.in)} | ` +
          `${parameter.required ? 'yes' : 'no'} | ${escapeTable(parameter.description ?? '')} |`,
      )
    }
    lines.push('')
  }
  if (operation.requestBody !== undefined) {
    lines.push('## Request body', '', '```json', prettyJson(operation.requestBody), '```', '')
  }
  if (operation.security !== undefined) {
    lines.push('## Security', '', '```json', prettyJson(operation.security), '```', '')
  }
  lines.push('## Responses', '')
  if (operation.responses.length === 0) {
    lines.push('No response schema is declared.', '')
  } else {
    for (const response of operation.responses) {
      lines.push(`### ${response.status}`, '', response.description || 'Response', '')
      if (response.schema !== undefined) {
        lines.push('```json', prettyJson(response.schema), '```', '')
      }
    }
  }
  if (operation.codeSamples.length > 0) {
    lines.push('## Request examples', '', '<CodeGroup title="Request">', '')
    for (const sample of operation.codeSamples) {
      const fence = codeFence(sample.code)
      const label = sample.label.replace(/["\r\n]/g, "'")
      lines.push(`${fence}${sample.syntax} title="${label}"`, sample.code, fence, '')
    }
    lines.push('</CodeGroup>', '')
  }
  return lines.join('\n')
}

function mergeParameters(
  pathParameters: unknown,
  operationParameters: unknown,
  document: Record<string, unknown>,
): DocumentationOpenApiParameter[] {
  const merged = new Map<string, DocumentationOpenApiParameter>()
  for (const values of [pathParameters, operationParameters]) {
    if (!Array.isArray(values)) continue
    for (const value of values) {
      for (const parameter of normalizeParameter(value, document)) {
        merged.set(`${parameter.in}\0${parameter.name}`, parameter)
      }
    }
  }
  return [...merged.values()]
}

function normalizeParameter(
  value: unknown,
  document: Record<string, unknown>,
): DocumentationOpenApiParameter[] {
  const parameter = resolveOpenApiObject(value, document)
  if (!parameter) return []
  if (typeof parameter.name !== 'string' || typeof parameter.in !== 'string') return []
  return [
    {
      name: parameter.name,
      in: parameter.in,
      required: parameter.required === true,
      ...(typeof parameter.description === 'string' ? { description: parameter.description } : {}),
      ...('schema' in parameter ? { schema: parameter.schema } : {}),
      ...('example' in parameter ? { example: parameter.example } : {}),
    },
  ]
}

function normalizeResponses(value: unknown, document: Record<string, unknown>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>).map(([status, response]) => {
    const data = resolveOpenApiObject(response, document)
    if (!data) {
      return { status, description: '' }
    }
    return {
      status,
      description: typeof data.description === 'string' ? data.description : '',
      ...('content' in data ? { schema: data.content } : {}),
    }
  })
}

function invalidOpenApi(file: string, message: string): DocumentationError {
  return new DocumentationError(`Invalid OpenAPI document: ${message}`, 'documentation_openapi_invalid', [
    { code: 'openapi_shape', message, file },
  ])
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function codeFence(source: string): string {
  const longest = Math.max(0, ...[...source.matchAll(/`+/g)].map((match) => match[0].length))
  return '`'.repeat(Math.max(3, longest + 1))
}

function firstServerUrl(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const server of value) {
    const object = asOpenApiObject(server)
    if (typeof object?.url === 'string') return object.url
  }
  return undefined
}

function swaggerServerUrl(document: OpenApiDocument): string | undefined {
  if (typeof document.host !== 'string' || !document.host) return undefined
  const scheme = Array.isArray(document.schemes)
    ? document.schemes.find((value): value is string => typeof value === 'string')
    : undefined
  const basePath = typeof document.basePath === 'string' ? document.basePath : ''
  return `${scheme ?? 'https'}://${document.host}${basePath}`
}
