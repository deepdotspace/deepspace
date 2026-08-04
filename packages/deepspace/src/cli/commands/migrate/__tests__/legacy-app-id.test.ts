import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLegacyAppId } from '../legacy-app-id'

describe('readLegacyAppId', () => {
  function withConfig(source: string, run: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'ds-legacy-id-'))
    try {
      writeFileSync(join(dir, 'wrangler.toml'), source)
      run(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('resolves matching pre-id Worker and APP_NAME declarations', () => {
    withConfig('name = "tickets"\n[vars]\nAPP_NAME = "tickets"\n', (dir) => {
      expect(readLegacyAppId(dir)).toBe('tickets')
    })
  })

  it('resolves an explicitly name-shaped DEEPSPACE_APP_ID for migration only', () => {
    withConfig('name = "tickets"\n[vars]\nDEEPSPACE_APP_ID = "tickets"\n', (dir) => {
      expect(readLegacyAppId(dir)).toBe('tickets')
    })
  })

  it('refuses mismatched legacy declarations instead of guessing', () => {
    withConfig('name = "worker-a"\n[vars]\nAPP_NAME = "worker-b"\n', (dir) => {
      expect(() => readLegacyAppId(dir)).toThrow(/does not match/)
    })
  })

  it('does not infer a legacy identity from a Worker name alone', () => {
    withConfig('name = "tickets"\n[vars]\n', (dir) => {
      expect(readLegacyAppId(dir)).toBeNull()
    })
  })

  it('refuses APP_NAME without an independent Worker name declaration', () => {
    withConfig('[vars]\nAPP_NAME = "tickets"\n', (dir) => {
      expect(() => readLegacyAppId(dir)).toThrow(/requires both Worker name and APP_NAME/)
    })
  })

  it('resolves an environment from its own non-inherited declarations', () => {
    withConfig(
      'name = "prod"\n[vars]\nAPP_NAME = "prod"\n[env.staging]\nname = "staging"\n[env.staging.vars]\nAPP_NAME = "staging"\n',
      (dir) => {
        expect(readLegacyAppId(dir, 'staging')).toBe('staging')
      },
    )
  })
})
