/**
 * Integration Test Page — browse and test all integration endpoints.
 *
 * Fetches the catalog from the API worker, renders typed form fields
 * from JSON Schema, and shows results.
 *
 * data-testid attributes for Playwright:
 *   integration-endpoint, integration-submit, integration-result,
 *   integration-error, integration-loading, integration-catalog
 */

import { useState, useEffect, useMemo } from 'react'
import { integration } from 'deepspace'
import type { IntegrationResponse } from 'deepspace'
import { useAuth } from 'deepspace'

// ============================================================================
// Types
// ============================================================================

interface CatalogEntry {
  endpoint: string
  billing: { model: string; baseCost: number; currency: string }
  inputSchema?: JsonSchema
  example?: Record<string, unknown>
}

interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
}

interface JsonSchemaProperty {
  type?: string
  enum?: unknown[]
  default?: unknown
  description?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  items?: JsonSchemaProperty
  properties?: Record<string, JsonSchemaProperty>
  anyOf?: JsonSchemaProperty[]
}

type Catalog = Record<string, CatalogEntry[]>

// ============================================================================
// Example Generation — build a complete example from schema + catalog defaults
// ============================================================================

function buildFullExample(schema?: JsonSchema | null, catalogExample?: Record<string, unknown>): Record<string, unknown> {
  const example: Record<string, unknown> = { ...catalogExample }
  if (!schema?.properties) return example

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (example[key] !== undefined) continue // already has a value from catalog

    if (prop.default !== undefined) {
      example[key] = prop.default
    } else if (prop.type === 'array' && prop.items) {
      example[key] = [buildExampleItem(prop.items)]
    } else if (prop.type === 'string' && prop.enum) {
      example[key] = prop.enum[0]
    }
    // Skip optional fields without defaults — user fills them in
  }
  return example
}

function buildExampleItem(items: JsonSchemaProperty): unknown {
  if (items.type === 'string') return 'example'
  if (items.type === 'number' || items.type === 'integer') return 0
  if (items.type === 'object' && items.properties) {
    const obj: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(items.properties)) {
      if (v.default !== undefined) obj[k] = v.default
      else if (v.enum) obj[k] = v.enum[0]
      else if (v.type === 'string') obj[k] = k
      else if (v.type === 'number' || v.type === 'integer') obj[k] = v.minimum ?? 0
      else if (v.type === 'boolean') obj[k] = false
      else if (v.anyOf) {
        const str = v.anyOf.find((a) => a.type === 'string')
        obj[k] = str ? k : null
      }
    }
    return obj
  }
  return null
}

// ============================================================================
// Schema Form — auto-generates form fields from JSON Schema
// ============================================================================

function SchemaForm({
  schema,
  values,
  onChange,
}: {
  schema: JsonSchema
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
}) {
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])

  const updateField = (key: string, value: unknown) => {
    onChange({ ...values, [key]: value })
  }

  return (
    <div className="space-y-3">
      {Object.entries(properties).map(([key, prop]) => (
        <div key={key}>
          <label className="block text-sm font-medium text-foreground mb-1">
            {key}
            {required.has(key) && <span className="text-destructive ml-0.5">*</span>}
            {prop.type && <span className="ml-1 text-xs text-muted-foreground">({prop.type})</span>}
          </label>
          <FieldInput
            prop={prop}
            value={values[key]}
            onChange={(v) => updateField(key, v)}
          />
        </div>
      ))}
    </div>
  )
}

function FieldInput({
  prop,
  value,
  onChange,
}: {
  prop: JsonSchemaProperty
  value: unknown
  onChange: (v: unknown) => void
}) {
  // Enum → select
  if (prop.enum) {
    return (
      <select
        value={String(value ?? prop.default ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
      >
        {prop.enum.map((v) => (
          <option key={String(v)} value={String(v)}>{String(v)}</option>
        ))}
      </select>
    )
  }

  // Boolean → checkbox
  if (prop.type === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={Boolean(value ?? prop.default ?? false)}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-border"
      />
    )
  }

  // Number → number input
  if (prop.type === 'number' || prop.type === 'integer') {
    return (
      <input
        type="number"
        value={value != null ? String(value) : String(prop.default ?? '')}
        min={prop.minimum}
        max={prop.maximum}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
      />
    )
  }

  // Array / Object → JSON textarea
  if (prop.type === 'array' || prop.type === 'object') {
    // Generate a meaningful placeholder for arrays of objects
    let defaultValue = prop.default ?? (prop.type === 'array' ? [] : {})
    if (prop.type === 'array' && Array.isArray(defaultValue) && defaultValue.length === 0 && prop.items?.properties) {
      // Build an example object from the items schema
      const exampleItem: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(prop.items.properties)) {
        if (v.default !== undefined) exampleItem[k] = v.default
        else if (v.enum) exampleItem[k] = v.enum[0]
        else if (v.type === 'string') exampleItem[k] = k
        else if (v.type === 'number' || v.type === 'integer') exampleItem[k] = v.minimum ?? 0
        else if (v.type === 'boolean') exampleItem[k] = false
        else if (v.anyOf) {
          // Pick the simplest type from anyOf
          const stringType = v.anyOf.find((a) => a.type === 'string')
          if (stringType) exampleItem[k] = k
          else exampleItem[k] = null
        }
      }
      defaultValue = [exampleItem]
    }
    const strValue = typeof value === 'string' ? value : JSON.stringify(value ?? defaultValue, null, 2)
    return (
      <textarea
        value={strValue}
        onChange={(e) => {
          try { onChange(JSON.parse(e.target.value)) } catch { onChange(e.target.value) }
        }}
        rows={Math.min(strValue.split('\n').length + 1, 8)}
        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground font-mono"
      />
    )
  }

  // Default → text input
  return (
    <input
      type="text"
      value={String(value ?? prop.default ?? '')}
      onChange={(e) => onChange(e.target.value || undefined)}
      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
      placeholder={prop.description ?? `Enter ${prop.type ?? 'value'}`}
    />
  )
}

// ============================================================================
// Page
// ============================================================================

export default function IntegrationTestPage() {
  const { isSignedIn } = useAuth()
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [endpoint, setEndpoint] = useState('openai/chat-completion')
  const [formValues, setFormValues] = useState<Record<string, unknown>>({})
  const [rawMode, setRawMode] = useState(false)
  const [rawBody, setRawBody] = useState('{}')
  const [result, setResult] = useState<IntegrationResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch catalog on mount
  useEffect(() => {
    integration.get<{ integrations?: Catalog } & Catalog>('').then((res) => {
      if (res.success && res.data) {
        const { integrations, ...rest } = res.data
        setCatalog(integrations ?? (rest as Catalog))
      }
    })
  }, [])

  // Find current endpoint's catalog entry
  const currentEntry = useMemo(() => {
    if (!catalog) return null
    const [name, ep] = endpoint.split('/')
    return catalog[name]?.find((e) => e.endpoint === ep) ?? null
  }, [catalog, endpoint])

  const selectEndpoint = (name: string, ep: string) => {
    setEndpoint(`${name}/${ep}`)
    setResult(null)
    setError(null)
    const entry = catalog?.[name]?.find((e) => e.endpoint === ep)
    const fullExample = buildFullExample(entry?.inputSchema, entry?.example ?? {})
    setFormValues(fullExample)
    setRawBody(JSON.stringify(fullExample, null, 2))
  }

  const handleSubmit = async () => {
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const body = rawMode ? JSON.parse(rawBody) : formValues
      const res = await integration.post(endpoint, body)
      setResult(res)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-bold text-foreground mb-2">Integration Tester</h1>
      <p className="text-sm text-muted-foreground mb-6">
        {isSignedIn ? 'Signed in — API calls will use your JWT.' : 'Not signed in — developer billing will be used.'}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Catalog */}
        <div data-testid="integration-catalog" className="md:col-span-1 space-y-3 max-h-[70vh] overflow-y-auto">
          {catalog ? (
            Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)).map(([name, endpoints]) => (
              <div key={name}>
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">{name}</div>
                <div className="space-y-0.5">
                  {endpoints.map((ep) => (
                    <button
                      key={ep.endpoint}
                      onClick={() => selectEndpoint(name, ep.endpoint)}
                      className={`block w-full text-left px-2 py-1 rounded text-sm transition-colors ${
                        endpoint === `${name}/${ep.endpoint}`
                          ? 'bg-primary/20 text-primary'
                          : 'text-foreground hover:bg-secondary'
                      }`}
                    >
                      {ep.endpoint}
                      <span className="ml-1 text-xs text-muted-foreground">
                        {ep.billing.model === 'per_request' ? `$${ep.billing.baseCost}` : ep.billing.model}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <div className="text-sm text-muted-foreground">Loading catalog...</div>
          )}
        </div>

        {/* Request / Response */}
        <div className="md:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <label className="block text-sm font-medium text-foreground mb-1">Endpoint</label>
              <input
                data-testid="integration-endpoint"
                type="text"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
              />
            </div>
            <button
              onClick={() => {
                setRawMode(!rawMode)
                if (!rawMode) setRawBody(JSON.stringify(formValues, null, 2))
                else try { setFormValues(JSON.parse(rawBody)) } catch { /* invalid JSON: keep current form values */ }
              }}
              className="ml-3 mt-5 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              {rawMode ? 'Form' : 'JSON'}
            </button>
          </div>

          {rawMode ? (
            <textarea
              data-testid="integration-body"
              value={rawBody}
              onChange={(e) => setRawBody(e.target.value)}
              rows={10}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground font-mono"
            />
          ) : currentEntry?.inputSchema ? (
            <SchemaForm
              schema={currentEntry.inputSchema}
              values={formValues}
              onChange={setFormValues}
            />
          ) : (
            <textarea
              data-testid="integration-body"
              value={rawBody}
              onChange={(e) => setRawBody(e.target.value)}
              rows={8}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground font-mono"
              placeholder="{}"
            />
          )}

          <button
            data-testid="integration-submit"
            onClick={handleSubmit}
            disabled={loading}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {loading ? 'Calling...' : 'Send Request'}
          </button>

          {loading && (
            <div data-testid="integration-loading" className="text-sm text-muted-foreground">
              Loading...
            </div>
          )}

          {error && (
            <div data-testid="integration-error" className="rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {result && !result.success && result.issues && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm space-y-1">
              <div className="font-medium text-destructive">{result.error}</div>
              {result.issues.map((issue, i) => (
                <div key={i} className="text-destructive/80">
                  <span className="font-mono">{issue.path?.join('.')}</span>: {issue.message}
                </div>
              ))}
            </div>
          )}

          {result && (
            <div className="space-y-2">
              <div data-testid="integration-status" className="text-sm font-medium text-foreground">
                {result.success ? '✓ Success' : '✗ Failed'}
              </div>
              <pre
                data-testid="integration-result"
                className="rounded-lg bg-card border border-border px-4 py-3 text-xs text-foreground font-mono overflow-auto max-h-96"
              >
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
