/**
 * DEV-2: dev/test/kill share ONE port precedence
 * (explicit > $DEEPSPACE_PORT > worktree > launch.json > default). These would
 * fail if any source were dropped — e.g. the earlier regression where `kill`
 * ignored $DEEPSPACE_PORT.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { DEFAULT_PORT, resolveDevServerPort } from '../../lib/port'

const originalEnv = process.env.DEEPSPACE_PORT

afterEach(() => {
  if (originalEnv === undefined) delete process.env.DEEPSPACE_PORT
  else process.env.DEEPSPACE_PORT = originalEnv
})

describe('resolveDevServerPort (DEV-2)', () => {
  it('explicit --port wins over everything', () => {
    process.env.DEEPSPACE_PORT = '9090'
    expect(resolveDevServerPort({ arg: '3000', worktree: () => 5190, appLaunch: () => 8790 })).toBe(3000)
  })
  it('$DEEPSPACE_PORT wins over derived worktree and launch.json ports', () => {
    process.env.DEEPSPACE_PORT = '9090'
    expect(resolveDevServerPort({ worktree: () => 5190, appLaunch: () => 8790 })).toBe(9090)
  })
  it('$DEEPSPACE_PORT wins over launch.json outside a worktree', () => {
    process.env.DEEPSPACE_PORT = '9090'
    expect(resolveDevServerPort({ appLaunch: () => 8790 })).toBe(9090)
  })
  it('the worktree port wins over launch.json', () => {
    delete process.env.DEEPSPACE_PORT
    expect(resolveDevServerPort({ worktree: () => 5190, appLaunch: () => 8790 })).toBe(5190)
  })
  it('falls to the launch.json port when no explicit/worktree/env', () => {
    delete process.env.DEEPSPACE_PORT
    expect(resolveDevServerPort({ appLaunch: () => 8790 })).toBe(8790)
  })
  it('falls to the default when nothing else is known', () => {
    delete process.env.DEEPSPACE_PORT
    expect(resolveDevServerPort({})).toBe(DEFAULT_PORT)
  })
})
