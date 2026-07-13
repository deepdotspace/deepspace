/**
 * DEV-1: `kill` must never report the port free when it couldn't actually
 * inspect the system (no lsof/pgrep and no /proc). noTargetsMessage encodes
 * that decision; these tests would fail if it regressed to always-ok.
 */
import { describe, it, expect } from 'vitest'
import { noTargetsMessage } from '../kill'

describe('noTargetsMessage (DEV-1)', () => {
  it('reports "nothing listening" when the port was inspected and empty', () => {
    const r = noTargetsMessage({ enumerated: true, swept: false, all: false, port: 5173 })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('Nothing listening on :5173')
  })

  it('ERRORS (not ok) when nothing could be inspected — no lsof/pgrep/proc', () => {
    const r = noTargetsMessage({ enumerated: false, swept: false, all: false, port: 8790 })
    expect(r.ok).toBe(false)
    expect(r.message).toContain("Couldn't determine")
    expect(r.message).toContain('8790')
  })

  it('is ok under --all when the name-sweep ran, even if the port was not enumerable', () => {
    const r = noTargetsMessage({ enumerated: false, swept: true, all: true, port: 5173 })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('no stray workerd/wrangler/vite')
  })

  it('ERRORS under --all when neither the port nor the name-sweep could run', () => {
    const r = noTargetsMessage({ enumerated: false, swept: false, all: true, port: 5173 })
    expect(r.ok).toBe(false)
    expect(r.message).toContain("Couldn't determine")
  })

  it('is ok when the port was enumerated even if --all sweep could not run', () => {
    const r = noTargetsMessage({ enumerated: true, swept: false, all: true, port: 5173 })
    expect(r.ok).toBe(true)
  })
})
