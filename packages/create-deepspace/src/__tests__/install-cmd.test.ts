import { describe, expect, it } from 'vitest'
import { resolveInstall, tailHint } from '../install-cmd'

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

describe('tailHint', () => {
  it('uses tail -f on POSIX', () => {
    expect(tailHint('.deepspace/install.log', 'linux')).toBe('tail -f .deepspace/install.log')
    expect(tailHint('.deepspace/install.log', 'darwin')).toBe('tail -f .deepspace/install.log')
  })

  it('uses PowerShell Get-Content -Wait on Windows (tail -f does not exist there)', () => {
    expect(tailHint('.deepspace/install.log', 'win32')).toBe(
      'Get-Content -Wait .deepspace/install.log',
    )
  })
})
