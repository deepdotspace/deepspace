/**
 * The dependency preflight is the other child a `test run` spawns, and under
 * `--json` its stdout is the one that used to break the contract: on Linux it
 * shells out to `apt-get`, whose transcript landed on stdout ahead of the
 * envelope, so `deepspace test run --json | jq` failed on every run in exactly
 * the containers the flag exists for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnSyncMock, execSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
  execSyncMock: vi.fn(),
}))
vi.mock('cross-spawn', () => ({ sync: spawnSyncMock }))
vi.mock('node:child_process', () => ({ execSync: execSyncMock }))

import { childStdio, ensurePlaywright, routeChildStdoutToStderr } from '../playwright'

afterEach(() => {
  routeChildStdoutToStderr(false)
  spawnSyncMock.mockReset()
  execSyncMock.mockReset()
  vi.restoreAllMocks()
})

/** Run the preflight as if it were root on Linux, where `--with-deps` fires. */
function asLinuxRoot(run: () => void): void {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const getuid = process.getuid
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  process.getuid = () => 0
  try {
    run()
  } finally {
    Object.defineProperty(process, 'platform', platform)
    process.getuid = getuid
  }
}

describe('test-run child output routing', () => {
  it('sends the preflight child stdout to stderr under the same flag as the suite', () => {
    spawnSyncMock.mockReturnValue({ status: 0 })

    routeChildStdoutToStderr(true)
    expect(childStdio()).toEqual(['inherit', 2, 2])
    ensurePlaywright('/app')
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'npx',
      ['playwright', 'install', 'chromium'],
      expect.objectContaining({ stdio: ['inherit', 2, 2] }),
    )

    routeChildStdoutToStderr(false)
    expect(childStdio()).toBe('inherit')
    ensurePlaywright('/app')
    expect(spawnSyncMock).toHaveBeenLastCalledWith(
      'npx',
      ['playwright', 'install', 'chromium'],
      expect.objectContaining({ stdio: 'inherit' }),
    )
  })

  it('keeps its own progress notices off stdout', () => {
    spawnSyncMock.mockReturnValue({ status: 0 })
    execSyncMock.mockImplementationOnce(() => {
      throw new Error('playwright not installed')
    })
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {})
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

    ensurePlaywright('/app')

    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledWith('Installing Playwright...')
  })

  it('says it is about to run apt as root before it does', () => {
    spawnSyncMock.mockReturnValue({ status: 0 })
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

    asLinuxRoot(() => ensurePlaywright('/app'))

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'npx',
      ['playwright', 'install', '--with-deps', 'chromium'],
      expect.anything(),
    )
    expect(stderr.mock.calls.flat().join('\n')).toContain('`apt-get` as root')
  })
})
