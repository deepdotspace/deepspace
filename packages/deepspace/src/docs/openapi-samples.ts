import {
  DEFAULT_DOCS_OPENAPI_EXAMPLES,
  type DocsOpenApiCodeSample,
  type DocsOpenApiExamplesConfig,
  type DocsOpenApiParameter,
  type DocsOpenApiSampleLanguage,
} from './types'
import { asOpenApiObject, resolveOpenApiObject, type OpenApiObject } from './openapi-object'

interface SampleOperation {
  method: string
  path: string
  baseUrl?: string
  parameters: DocsOpenApiParameter[]
  requestBody?: unknown
  security?: unknown
}

const LANGUAGE_METADATA: Record<DocsOpenApiSampleLanguage, { label: string; syntax: string }> = {
  curl: { label: 'cURL', syntax: 'bash' },
  javascript: { label: 'JavaScript', syntax: 'javascript' },
  python: { label: 'Python', syntax: 'python' },
  go: { label: 'Go', syntax: 'go' },
}

export function createOpenApiCodeSamples(
  operation: SampleOperation,
  document: OpenApiObject,
  examples: DocsOpenApiExamplesConfig | undefined,
  customSamples: unknown,
): DocsOpenApiCodeSample[] {
  const custom = normalizeCustomSamples(customSamples)
  if (examples?.autogenerate === false || !operation.baseUrl) return custom

  const languages = examples?.languages ?? DEFAULT_DOCS_OPENAPI_EXAMPLES.languages
  const defaults = examples?.defaults ?? DEFAULT_DOCS_OPENAPI_EXAMPLES.defaults
  const request = buildSampleRequest(operation, document, defaults === 'all')
  const customLanguages = new Set(custom.map((sample) => knownLanguage(sample.language)))
  const generated = languages
    .filter((language) => !customLanguages.has(language))
    .map(
      (language): DocsOpenApiCodeSample => ({
        language,
        label: LANGUAGE_METADATA[language].label,
        syntax: LANGUAGE_METADATA[language].syntax,
        code: renderSample(language, request),
        generated: true,
      }),
    )
  return [...custom, ...generated]
}

interface SampleRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: unknown
}

function buildSampleRequest(
  operation: SampleOperation,
  document: OpenApiObject,
  includeOptional: boolean,
): SampleRequest {
  let path = operation.path
  const query = new URLSearchParams()
  const headers: Record<string, string> = { Accept: 'application/json' }
  const cookies: string[] = []
  const parameters = operation.parameters.filter(
    (parameter) => parameter.required || includeOptional,
  )

  for (const parameter of parameters) {
    const value = sampleParameterValue(parameter, document)
    if (parameter.in === 'path') {
      path = path.replaceAll(`{${parameter.name}}`, encodeURIComponent(String(value)))
    } else if (parameter.in === 'query') {
      query.set(parameter.name, String(value))
    } else if (parameter.in === 'header') {
      headers[parameter.name] = String(value)
    } else if (parameter.in === 'cookie') {
      cookies.push(`${parameter.name}=${String(value)}`)
    }
  }
  path = path.replace(/\{([^}]+)\}/g, (_match, name: string) =>
    encodeURIComponent(`example-${slugPart(name)}`),
  )

  applySecurity(operation.security ?? document.security, document, headers, query, cookies)
  if (cookies.length > 0) headers.Cookie = cookies.join('; ')

  const body = requestBodyExample(operation.requestBody, document, includeOptional)
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const separator = path.includes('?') ? '&' : '?'
  const search = query.toString()
  const url = `${operation.baseUrl?.replace(/\/$/, '') ?? ''}${path}${search ? `${separator}${search}` : ''}`
  return { method: operation.method, url, headers, ...(body === undefined ? {} : { body }) }
}

function sampleParameterValue(parameter: DocsOpenApiParameter, document: OpenApiObject): unknown {
  if (parameter.example !== undefined) return parameter.example
  const schema = resolveOpenApiObject(parameter.schema, document)
  if (schema) {
    if (schema.example !== undefined) return schema.example
    if (schema.default !== undefined) return schema.default
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
    if (schema.type === 'boolean') return true
    if (schema.type === 'integer' || schema.type === 'number') return 1
  }
  return `example-${slugPart(parameter.name)}`
}

function requestBodyExample(
  value: unknown,
  document: OpenApiObject,
  includeOptional: boolean,
): unknown {
  const requestBody = resolveOpenApiObject(value, document)
  if (!requestBody) return undefined
  const content = asOpenApiObject(requestBody.content)
  if (!content) return undefined
  const jsonMedia = Object.entries(content).find(([contentType]) => contentType.endsWith('+json'))
  const media = asOpenApiObject(content['application/json']) ?? asOpenApiObject(jsonMedia?.[1])
  if (!media) return undefined
  if (media.example !== undefined) return media.example
  const namedExamples = asOpenApiObject(media.examples)
  if (namedExamples) {
    for (const example of Object.values(namedExamples)) {
      const resolved = resolveOpenApiObject(example, document)
      if (resolved && resolved.value !== undefined) return resolved.value
    }
  }
  return schemaExample(media.schema, document, includeOptional, new Set(), 0)
}

function schemaExample(
  value: unknown,
  document: OpenApiObject,
  includeOptional: boolean,
  seen: Set<string>,
  depth: number,
): unknown {
  if (depth > 8) return undefined
  const schema = resolveOpenApiObject(value, document, seen)
  if (!schema) return undefined
  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined
  if (alternatives?.[0] !== undefined) {
    return schemaExample(alternatives[0], document, includeOptional, seen, depth + 1)
  }
  if (Array.isArray(schema.allOf)) {
    return Object.assign(
      {},
      ...schema.allOf.map((part) => {
        const example = schemaExample(part, document, includeOptional, seen, depth + 1)
        return asOpenApiObject(example) ?? {}
      }),
    )
  }
  const properties = asOpenApiObject(schema.properties)
  if (schema.type === 'object' || properties) {
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((name): name is string => typeof name === 'string')
        : [],
    )
    return Object.fromEntries(
      Object.entries(properties ?? {})
        .filter(([name]) => includeOptional || required.has(name))
        .map(([name, property]) => [
          name,
          schemaExample(property, document, includeOptional, new Set(seen), depth + 1),
        ])
        .filter((entry) => entry[1] !== undefined),
    )
  }
  if (schema.type === 'array' || schema.items !== undefined) {
    const item = schemaExample(schema.items, document, includeOptional, seen, depth + 1)
    return item === undefined ? [] : [item]
  }
  if (schema.type === 'boolean') return true
  if (schema.type === 'integer' || schema.type === 'number') return 1
  if (schema.type === 'string') return stringExample(schema.format)
  return undefined
}

function stringExample(format: unknown): string {
  switch (format) {
    case 'date-time':
      return '2026-01-01T00:00:00Z'
    case 'date':
      return '2026-01-01'
    case 'email':
      return 'user@example.com'
    case 'uuid':
      return '00000000-0000-4000-8000-000000000000'
    case 'uri':
    case 'url':
      return 'https://example.com'
    default:
      return 'string'
  }
}

function applySecurity(
  value: unknown,
  document: OpenApiObject,
  headers: Record<string, string>,
  query: URLSearchParams,
  cookies: string[],
): void {
  if (!Array.isArray(value)) return
  const requirement = value.map(asOpenApiObject).find(Boolean)
  if (!requirement) return
  const schemes = asOpenApiObject(asOpenApiObject(document.components)?.securitySchemes)
  for (const name of Object.keys(requirement)) {
    const scheme = resolveOpenApiObject(schemes?.[name], document)
    if (!scheme) continue
    if (scheme.type === 'http' && scheme.scheme === 'bearer') {
      headers.Authorization = 'Bearer <token>'
    } else if (scheme.type === 'http' && scheme.scheme === 'basic') {
      headers.Authorization = 'Basic <credentials>'
    } else if (scheme.type === 'apiKey' && typeof scheme.name === 'string') {
      if (scheme.in === 'query') query.set(scheme.name, '<api-key>')
      else if (scheme.in === 'cookie') cookies.push(`${scheme.name}=<api-key>`)
      else headers[scheme.name] = '<api-key>'
    }
  }
}

function renderSample(language: DocsOpenApiSampleLanguage, request: SampleRequest): string {
  switch (language) {
    case 'curl':
      return renderCurl(request)
    case 'javascript':
      return renderJavaScript(request)
    case 'python':
      return renderPython(request)
    case 'go':
      return renderGo(request)
  }
}

function renderCurl(request: SampleRequest): string {
  const lines = [`curl --request ${request.method} \\`, `  --url '${escapeShell(request.url)}'`]
  for (const [name, value] of Object.entries(request.headers)) {
    lines[lines.length - 1] += ' \\'
    lines.push(`  --header '${escapeShell(`${name}: ${value}`)}'`)
  }
  if (request.body !== undefined) {
    lines[lines.length - 1] += ' \\'
    lines.push(`  --data '${escapeShell(prettyJson(request.body))}'`)
  }
  return lines.join('\n')
}

function renderJavaScript(request: SampleRequest): string {
  const options = [
    `method: ${JSON.stringify(request.method)}`,
    `headers: ${indent(prettyJson(request.headers), 2).trimStart()}`,
    ...(request.body === undefined
      ? []
      : [`body: JSON.stringify(${indent(prettyJson(request.body), 2).trimStart()})`]),
  ]
  return [
    `const response = await fetch(${JSON.stringify(request.url)}, {`,
    options.map((option) => `  ${option},`).join('\n'),
    '})',
    '',
    'if (!response.ok) throw new Error(`Request failed: ${response.status}`)',
    'const data = await response.json()',
    'console.log(data)',
  ].join('\n')
}

function renderPython(request: SampleRequest): string {
  const arguments_ = [
    JSON.stringify(request.method),
    JSON.stringify(request.url),
    `headers=${pythonValue(request.headers)}`,
    ...(request.body === undefined ? [] : [`json=${pythonValue(request.body)}`]),
  ]
  return [
    'import requests',
    '',
    'response = requests.request(',
    arguments_.map((argument) => `    ${argument},`).join('\n'),
    ')',
    'response.raise_for_status()',
    'print(response.json())',
  ].join('\n')
}

function renderGo(request: SampleRequest): string {
  const requestBody =
    request.body === undefined
      ? 'nil'
      : `strings.NewReader(${JSON.stringify(prettyJson(request.body))})`
  const imports = ['"fmt"', '"io"', '"net/http"']
  if (request.body !== undefined) imports.push('"strings"')
  return [
    'package main',
    '',
    'import (',
    ...imports.map((value) => `\t${value}`),
    ')',
    '',
    'func main() {',
    `\treq, err := http.NewRequest(${JSON.stringify(request.method)}, ${JSON.stringify(request.url)}, ${requestBody})`,
    '\tif err != nil { panic(err) }',
    ...Object.entries(request.headers).map(
      ([name, value]) => `\treq.Header.Set(${JSON.stringify(name)}, ${JSON.stringify(value)})`,
    ),
    '',
    '\tres, err := http.DefaultClient.Do(req)',
    '\tif err != nil { panic(err) }',
    '\tdefer res.Body.Close()',
    '',
    '\tbody, err := io.ReadAll(res.Body)',
    '\tif err != nil { panic(err) }',
    '\tfmt.Println(string(body))',
    '}',
  ].join('\n')
}

function normalizeCustomSamples(value: unknown): DocsOpenApiCodeSample[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): DocsOpenApiCodeSample[] => {
    const sample = asOpenApiObject(entry)
    const language = typeof sample?.lang === 'string' ? sample.lang.trim().toLowerCase() : ''
    const source = typeof sample?.source === 'string' ? sample.source.trim() : ''
    if (!language || !source) return []
    const normalizedLanguage = knownLanguage(language)
    const label =
      typeof sample?.label === 'string' && sample.label.trim()
        ? sample.label.trim()
        : normalizedLanguage
          ? LANGUAGE_METADATA[normalizedLanguage].label
          : language
    return [
      {
        language,
        label,
        syntax: syntaxForLanguage(language),
        code: source,
        generated: false,
      },
    ]
  })
}

function knownLanguage(value: string): DocsOpenApiSampleLanguage | undefined {
  if (['curl', 'bash', 'shell', 'sh'].includes(value)) return 'curl'
  if (['javascript', 'js', 'node', 'nodejs'].includes(value)) return 'javascript'
  if (['python', 'py'].includes(value)) return 'python'
  if (['go', 'golang'].includes(value)) return 'go'
  return undefined
}

function syntaxForLanguage(value: string): string {
  const known = knownLanguage(value)
  return known ? LANGUAGE_METADATA[known].syntax : value.replace(/[^a-z0-9_+#.-]/g, '') || 'text'
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function pythonValue(value: unknown): string {
  return prettyJson(value)
    .replace(/\btrue\b/g, 'True')
    .replace(/\bfalse\b/g, 'False')
    .replace(/\bnull\b/g, 'None')
}

function escapeShell(value: string): string {
  return value.replace(/'/g, `'"'"'`)
}

function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces)
  return value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

function slugPart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'value'
  )
}
