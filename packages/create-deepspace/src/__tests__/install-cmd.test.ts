import { describe, expect, it } from 'vitest'
import { resolveInstall } from '../install-cmd'

describe('resolveInstall', () => {
  it('follows the package manager that invoked the scaffold', () => {
    expect(resolveInstall(true, 'npm/10.8.2 node/v24.0.0 darwin arm64')).toEqual({
      cmd: 'npm',
      args: ['install', '--no-fund', '--no-audit'],
    })
    expect(resolveInstall(false, 'bun/1.2.0')).toEqual({
      cmd: 'bun',
      args: ['install', '--force'],
    })
    expect(resolveInstall(true, 'pnpm/9.0.0 npm/? node/v24.0.0')).toEqual({
      cmd: 'pnpm',
      args: ['install'],
    })
    expect(resolveInstall(true, 'yarn/4.0.0 npm/? node/v24.0.0')).toEqual({
      cmd: 'yarn',
      args: ['install'],
    })
  })

  it('uses bun --force for direct invocations when bun is present (refreshes its stale metadata cache)', () => {
    expect(resolveInstall(true, undefined)).toEqual({ cmd: 'bun', args: ['install', '--force'] })
  })

  it('falls back to npm with the quiet flags when bun is absent', () => {
    expect(resolveInstall(false, undefined)).toEqual({
      cmd: 'npm',
      args: ['install', '--no-fund', '--no-audit'],
    })
  })

  it('ignores an unrecognized user agent', () => {
    expect(resolveInstall(false, 'deno/2.0.0')).toEqual({
      cmd: 'npm',
      args: ['install', '--no-fund', '--no-audit'],
    })
  })
})
