import { describe, it, expect } from 'vitest'
import {
  validateBindingManifest,
  bindingManifestFromOutputConfig,
  RESERVED_BINDING_NAMES,
  AUTO_PROVISION_SENTINEL,
  isAutoProvision,
} from '../binding-manifest'

describe('validateBindingManifest', () => {
  it('accepts an empty array', () => {
    const r = validateBindingManifest([])
    expect(r.valid).toBe(true)
    if (r.valid) expect(r.bindings).toEqual([])
  })

  it('accepts known binding types with required fields', () => {
    const r = validateBindingManifest([
      { type: 'ai', name: 'AI' },
      { type: 'vectorize', name: 'VECTORS', index_name: 'unison-candidates' },
      { type: 'r2_bucket', name: 'FILES', bucket_name: 'unison-search-files' },
      { type: 'browser_rendering', name: 'BROWSER' },
    ])
    expect(r.valid).toBe(true)
  })

  it('rejects non-array input', () => {
    for (const input of [{ type: 'ai', name: 'AI' }, null, undefined, 'foo', 42, true]) {
      const r = validateBindingManifest(input)
      expect(r.valid).toBe(false)
      if (!r.valid) {
        expect(r.errors[0].reason).toBe('Manifest must be an array')
        expect(r.errors[0].binding).toBeUndefined() // top-level error has no binding
      }
    }
  })

  it('rejects entries that are not objects', () => {
    const r = validateBindingManifest([null, 'foo', 42, true])
    expect(r.valid).toBe(false)
    if (!r.valid) {
      expect(r.errors).toHaveLength(4)
      expect(r.errors[0].reason).toMatch(/Entry must be an object \(got null\)/)
      expect(r.errors[1].reason).toMatch(/got string/)
      expect(r.errors[2].reason).toMatch(/got number/)
      expect(r.errors[3].reason).toMatch(/got boolean/)
    }
  })

  it('rejects entries with non-string type', () => {
    const r = validateBindingManifest([{ type: 42, name: 'x' }])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.errors[0].reason).toMatch(/Disallowed binding type/)
  })

  it('rejects unknown binding types', () => {
    const r = validateBindingManifest([{ type: 'mtls_certificate', name: 'CERT' }])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.errors[0].reason).toMatch(/Disallowed binding type/)
  })

  it('rejects reserved binding names', () => {
    const r = validateBindingManifest([{ type: 'r2_bucket', name: 'ASSETS', bucket_name: 'x' }])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.errors[0].reason).toMatch(/reserved/)
  })

  it('rejects USAGE_EVENTS (auto-attached for cost tracking)', () => {
    const r = validateBindingManifest([
      { type: 'analytics_engine', name: 'USAGE_EVENTS', dataset: 'x' },
    ])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.errors[0].reason).toMatch(/reserved/)
  })

  it('rejects duplicate binding names', () => {
    const r = validateBindingManifest([
      { type: 'ai', name: 'X' },
      { type: 'browser_rendering', name: 'X' },
    ])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.errors[0].reason).toMatch(/Duplicate/)
  })

  it('rejects vectorize without index_name', () => {
    const r = validateBindingManifest([{ type: 'vectorize', name: 'V' }])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.errors[0].reason).toMatch(/missing index_name/)
  })

  it('rejects r2_bucket without bucket_name', () => {
    const r = validateBindingManifest([{ type: 'r2_bucket', name: 'F' }])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.errors[0].reason).toMatch(/missing bucket_name/)
  })

  it('rejects entries without a name', () => {
    const r = validateBindingManifest([{ type: 'ai' }])
    expect(r.valid).toBe(false)
  })

  it('reserved name set is the exact platform-managed set', () => {
    // Explicit equality so the failure diff names which entries were added
    // or removed (vs. a `.size === N` assertion that just says "wrong count").
    expect(RESERVED_BINDING_NAMES).toEqual(
      new Set([
        'ASSETS',
        'PLATFORM_WORKER',
        'API_WORKER',
        'APP_NAME',
        'OWNER_USER_ID',
        'AUTH_JWT_PUBLIC_KEY',
        'AUTH_JWT_ISSUER',
        'AUTH_WORKER_URL',
        'APP_IDENTITY_TOKEN',
        'APP_OWNER_JWT',
        'USAGE_EVENTS',
      ]),
    )
  })
})

describe('bindingManifestFromOutputConfig', () => {
  it('returns empty for an empty config', () => {
    expect(bindingManifestFromOutputConfig({})).toEqual([])
  })

  it('extracts the AI binding', () => {
    expect(bindingManifestFromOutputConfig({ ai: { binding: 'AI' } })).toEqual([
      { type: 'ai', name: 'AI' },
    ])
  })

  it('extracts vectorize bindings (array)', () => {
    expect(
      bindingManifestFromOutputConfig({
        vectorize: [{ binding: 'VECTORS', index_name: 'candidates' }],
      }),
    ).toEqual([{ type: 'vectorize', name: 'VECTORS', index_name: 'candidates' }])
  })

  it('extracts r2 + kv + d1 + queue + browser + AE + hyperdrive together with full shapes', () => {
    const out = bindingManifestFromOutputConfig({
      r2_buckets: [{ binding: 'FILES', bucket_name: 'b' }],
      kv_namespaces: [{ binding: 'CACHE', id: 'kv-id' }],
      d1_databases: [{ binding: 'DB', database_id: 'd1-id' }],
      queues: { producers: [{ binding: 'TASKS', queue: 'q' }] },
      browser: { binding: 'BROWSER' },
      analytics_engine_datasets: [{ binding: 'EVENTS', dataset: 'd' }],
      hyperdrive: [{ binding: 'PG', id: 'hd-id' }],
    })
    expect(out).toEqual([
      { type: 'r2_bucket', name: 'FILES', bucket_name: 'b' },
      { type: 'kv_namespace', name: 'CACHE', namespace_id: 'kv-id' },
      { type: 'd1', name: 'DB', id: 'd1-id' },
      { type: 'queue', name: 'TASKS', queue_name: 'q' },
      { type: 'browser_rendering', name: 'BROWSER' },
      { type: 'analytics_engine', name: 'EVENTS', dataset: 'd' },
      { type: 'hyperdrive', name: 'PG', id: 'hd-id' },
    ])
  })

  it('analytics_engine: dataset is optional', () => {
    expect(
      bindingManifestFromOutputConfig({ analytics_engine_datasets: [{ binding: 'X' }] }),
    ).toEqual([{ type: 'analytics_engine', name: 'X', dataset: undefined }])
  })

  it('tolerates non-object values in array slots', () => {
    expect(
      bindingManifestFromOutputConfig({
        vectorize: [null, 'foo', { binding: 'V', index_name: 'i' }, 42],
      }),
    ).toEqual([{ type: 'vectorize', name: 'V', index_name: 'i' }])
  })

  it('skips entries missing required fields', () => {
    expect(
      bindingManifestFromOutputConfig({
        vectorize: [{ binding: 'V' }, { binding: 'V2', index_name: 'idx' }],
      }),
    ).toEqual([{ type: 'vectorize', name: 'V2', index_name: 'idx' }])
  })

  it('output composes cleanly with validateBindingManifest', () => {
    const extracted = bindingManifestFromOutputConfig({
      ai: { binding: 'AI' },
      vectorize: [{ binding: 'VECTORS', index_name: 'candidates' }],
    })
    const v = validateBindingManifest(extracted)
    expect(v.valid).toBe(true)
  })

  it('extracts d1 with optional database_name when present', () => {
    expect(
      bindingManifestFromOutputConfig({
        d1_databases: [{ binding: 'DB', database_id: 'auto', database_name: 'my-db' }],
      }),
    ).toEqual([{ type: 'd1', name: 'DB', id: 'auto', database_name: 'my-db' }])
  })

  it('extracts kv with optional title when present', () => {
    expect(
      bindingManifestFromOutputConfig({
        kv_namespaces: [{ binding: 'KV', id: 'auto', title: 'my-kv' }],
      }),
    ).toEqual([{ type: 'kv_namespace', name: 'KV', namespace_id: 'auto', title: 'my-kv' }])
  })

  it('extracts vectorize with dimensions + metric when present', () => {
    expect(
      bindingManifestFromOutputConfig({
        vectorize: [{ binding: 'V', index_name: 'auto', dimensions: 1024, metric: 'cosine' }],
      }),
    ).toEqual([
      { type: 'vectorize', name: 'V', index_name: 'auto', dimensions: 1024, metric: 'cosine' },
    ])
  })

  it('drops invalid vectorize metric value silently (validator catches it later)', () => {
    expect(
      bindingManifestFromOutputConfig({
        vectorize: [{ binding: 'V', index_name: 'auto', dimensions: 768, metric: 'manhattan' }],
      }),
    ).toEqual([
      // metric stripped because it isn't one of the recognized values; validator
      // will then reject this as missing metric.
      { type: 'vectorize', name: 'V', index_name: 'auto', dimensions: 768 },
    ])
  })
})

describe('AUTO_PROVISION_SENTINEL + validator', () => {
  it('sentinel is the literal string "auto"', () => {
    expect(AUTO_PROVISION_SENTINEL).toBe('auto')
  })

  it('accepts d1 id="auto" with database_name', () => {
    const r = validateBindingManifest([
      { type: 'd1', name: 'DB', id: 'auto', database_name: 'my-db' },
    ])
    expect(r.valid).toBe(true)
  })

  it('rejects d1 id="auto" without database_name', () => {
    const r = validateBindingManifest([{ type: 'd1', name: 'DB', id: 'auto' }])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.errors[0].reason).toMatch(/requires "database_name"/)
  })

  it('accepts kv namespace_id="auto" with title', () => {
    const r = validateBindingManifest([
      { type: 'kv_namespace', name: 'KV', namespace_id: 'auto', title: 'my-kv' },
    ])
    expect(r.valid).toBe(true)
  })

  it('rejects kv namespace_id="auto" without title', () => {
    const r = validateBindingManifest([
      { type: 'kv_namespace', name: 'KV', namespace_id: 'auto' },
    ])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.errors[0].reason).toMatch(/requires "title"/)
  })

  it('accepts vectorize index_name="auto" with dimensions + metric', () => {
    const r = validateBindingManifest([
      { type: 'vectorize', name: 'V', index_name: 'auto', dimensions: 1024, metric: 'cosine' },
    ])
    expect(r.valid).toBe(true)
  })

  it('rejects vectorize index_name="auto" without dimensions', () => {
    const r = validateBindingManifest([
      { type: 'vectorize', name: 'V', index_name: 'auto', metric: 'cosine' },
    ])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.errors[0].reason).toMatch(/requires "dimensions"/)
  })

  it('rejects vectorize index_name="auto" without metric', () => {
    const r = validateBindingManifest([
      { type: 'vectorize', name: 'V', index_name: 'auto', dimensions: 1024 },
    ])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.errors[0].reason).toMatch(/requires "metric"/)
  })

  it('rejects vectorize with dimensions=0 (must be positive)', () => {
    const r = validateBindingManifest([
      { type: 'vectorize', name: 'V', index_name: 'auto', dimensions: 0, metric: 'cosine' },
    ])
    expect(r.valid).toBe(false)
  })

  it('accepts r2 bucket_name="auto" (no companion fields needed)', () => {
    const r = validateBindingManifest([{ type: 'r2_bucket', name: 'F', bucket_name: 'auto' }])
    expect(r.valid).toBe(true)
  })

  it('accepts queue queue_name="auto" (no companion fields needed)', () => {
    const r = validateBindingManifest([{ type: 'queue', name: 'Q', queue_name: 'auto' }])
    expect(r.valid).toBe(true)
  })

  it('rejects hyperdrive id="auto" — auto-provisioning out of scope', () => {
    const r = validateBindingManifest([{ type: 'hyperdrive', name: 'PG', id: 'auto' }])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.errors[0].reason).toMatch(/auto-provisioning not yet supported/)
  })

  it('isAutoProvision identifies sentinel-bearing bindings only', () => {
    expect(isAutoProvision({ type: 'd1', name: 'DB', id: 'auto', database_name: 'x' })).toBe(true)
    expect(isAutoProvision({ type: 'd1', name: 'DB', id: 'real-uuid' })).toBe(false)
    expect(isAutoProvision({ type: 'ai', name: 'AI' })).toBe(false)
    expect(
      isAutoProvision({ type: 'vectorize', name: 'V', index_name: 'auto', dimensions: 1024, metric: 'cosine' }),
    ).toBe(true)
    expect(
      isAutoProvision({ type: 'r2_bucket', name: 'F', bucket_name: 'auto' }),
    ).toBe(true)
  })
})
