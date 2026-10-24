import { afterEach, describe, expect, it, vi } from 'vitest'
import { chromiumLaunchOptions } from '../browser'

afterEach(() => vi.unstubAllEnvs())

describe('container browser selection', () => {
  it('leaves Playwright defaults intact without an override', () => {
    vi.stubEnv('DEEPSPACE_TEST_BROWSER_EXECUTABLE_PATH', undefined)
    expect(chromiumLaunchOptions()).toEqual({})
  })

  it('passes an existing executable through to Playwright', () => {
    vi.stubEnv('DEEPSPACE_TEST_BROWSER_EXECUTABLE_PATH', process.execPath)
    expect(chromiumLaunchOptions()).toEqual({ executablePath: process.execPath })
  })

  it.each(['relative/chromium', '/does-not-exist/deepspace-test-browser', process.cwd()])(
    'rejects invalid browser path %s without silently downloading a replacement',
    (path) => {
      vi.stubEnv('DEEPSPACE_TEST_BROWSER_EXECUTABLE_PATH', path)
      expect(chromiumLaunchOptions).toThrow('must name an existing executable file')
    },
  )
})
