export type OpenApiObject = Record<string, unknown>

export function asOpenApiObject(value: unknown): OpenApiObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as OpenApiObject)
    : undefined
}

export function resolveOpenApiObject(
  value: unknown,
  document: OpenApiObject,
  seen: Set<string> = new Set(),
): OpenApiObject | undefined {
  const object = asOpenApiObject(value)
  if (!object || typeof object.$ref !== 'string') return object
  const reference = object.$ref
  if (!reference.startsWith('#/') || seen.has(reference)) return undefined
  seen.add(reference)
  let resolved: unknown = document
  for (const segment of reference.slice(2).split('/')) {
    resolved = asOpenApiObject(resolved)?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  const target = asOpenApiObject(resolved)
  if (!target) return undefined
  const siblings = Object.fromEntries(Object.entries(object).filter(([key]) => key !== '$ref'))
  return { ...target, ...siblings }
}
