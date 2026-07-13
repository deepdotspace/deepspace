/**
 * Node-version preflight: the Cloudflare Vite plugin needs
 * `module.registerHooks`, and Nodes without it fail with a cryptic ESM
 * error. The check feature-detects the export; these lock both branches.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { preflightNodeVersion } from '../preflight'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('preflightNodeVersion', () => {
  it('is a no-op on a Node that ships registerHooks (this test runtime)', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    preflightNodeVersion('deploy')
    expect(exit).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('prints the fix and exits 1 when registerHooks is missing', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    preflightNodeVersion('deploy', false)
    expect(exit).toHaveBeenCalledWith(1)
    expect(error.mock.calls[0][0]).toContain('deepspace deploy requires Node 22.15 or newer')
  })
})
