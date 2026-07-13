import { describe, it, expect } from 'vitest'
import { validateDoManifest } from '../do-manifest'

describe('validateDoManifest', () => {
  it('accepts a well-formed manifest', () => {
    const r = validateDoManifest([
      { binding: 'RECORD_ROOMS', className: 'AppRecordRoom', sqlite: true },
      { binding: 'YJS_ROOMS', className: 'AppYjsRoom', sqlite: true },
    ])
    expect(r.valid).toBe(true)
    if (r.valid) expect(r.manifest).toHaveLength(2)
  })

  it('accepts an empty manifest (no DOs)', () => {
    const r = validateDoManifest([])
    expect(r.valid).toBe(true)
    if (r.valid) expect(r.manifest).toEqual([])
  })

  it('rejects non-array input', () => {
    for (const bad of [null, undefined, 'foo', 42, {}, true]) {
      const r = validateDoManifest(bad)
      expect(r.valid).toBe(false)
      if (!r.valid) expect(r.reason).toMatch(/must be an array/)
    }
  })

  it('rejects entries that are not objects', () => {
    const r = validateDoManifest([null])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.reason).toMatch(/Entry must be an object \(got null\)/i)
  })

  it('rejects entries missing binding', () => {
    const r = validateDoManifest([{ className: 'C', sqlite: true }])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.reason).toMatch(/missing 'binding'/)
  })

  it('rejects entries missing className', () => {
    const r = validateDoManifest([{ binding: 'B', sqlite: true }])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.reason).toMatch(/missing 'className'/)
  })

  it('rejects entries with non-boolean sqlite', () => {
    const r = validateDoManifest([{ binding: 'B', className: 'C', sqlite: 'yes' }])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.reason).toMatch(/'sqlite' must be a boolean/)
  })

  it('rejects duplicate binding names', () => {
    const r = validateDoManifest([
      { binding: 'B', className: 'C1', sqlite: true },
      { binding: 'B', className: 'C2', sqlite: false },
    ])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.reason).toMatch(/duplicate binding/i)
  })

  it('returns the manifest when valid (callers use this directly)', () => {
    const r = validateDoManifest([{ binding: 'B', className: 'C', sqlite: false }])
    if (r.valid) {
      expect(r.manifest[0]).toEqual({ binding: 'B', className: 'C', sqlite: false })
    }
  })
})
