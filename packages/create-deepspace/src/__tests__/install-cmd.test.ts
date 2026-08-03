import { describe, expect, it } from 'vitest'
import { resolveInstall } from '../install-cmd'

describe('resolveInstall', () => {
  it('uses bun --force when bun is present (refreshes its stale metadata cache)', () => {
    expect(resolveInstall(true)).toEqual({ cmd: 'bun', args: ['install', '--force'] })
  })

  it('falls back to npm with the quiet flags when bun is absent', () => {
    expect(resolveInstall(false)).toEqual({
      cmd: 'npm',
      args: ['install', '--no-fund', '--no-audit'],
    })
  })
})
