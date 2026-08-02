/**
 * Node-version preflight: the Cloudflare Vite plugin needs
 * `module.registerHooks`, and Nodes without it fail with a cryptic ESM
 * error. The check feature-detects the export; these lock both branches.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { Refusal } from '../command'
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

  it('refuses with node_too_old when registerHooks is missing', () => {
    // A Refusal (not process.exit) so the runtime renders it on both output
    // paths — an exit here left --json callers with empty stdout.
    let caught: unknown
    try {
      preflightNodeVersion('deploy', false)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Refusal)
    expect((caught as Refusal).code).toBe('node_too_old')
    expect((caught as Refusal).message).toContain('deepspace deploy requires Node 22.15 or newer')
  })
})
