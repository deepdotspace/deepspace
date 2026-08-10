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

  it('refuses when registerHooks is missing', () => {
    // A Refusal (not process.exit) so the runtime renders it on both output
    // paths — an exit here left --json callers with empty stdout.
    let caught: unknown
    try {
      preflightNodeVersion('deploy', false, '22.15.0')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Refusal)
    expect((caught as Refusal).code).toBe('node_capability_missing')
    expect((caught as Refusal).message).toContain('22.15+, 24, or 26')
  })

  it.each(['22.14.0', '23.11.1', '25.9.0', '27.0.0'])(
    'refuses unsupported Node %s even when registerHooks exists',
    (version) => {
      expect(() => preflightNodeVersion('dev', true, version)).toThrowError(
        expect.objectContaining({ code: 'node_unsupported' }),
      )
    },
  )

  it.each(['22.15.0', '22.23.1', '24.19.0', '26.5.1'])(
    'accepts supported Node %s when registerHooks exists',
    (version) => {
      expect(() => preflightNodeVersion('dev', true, version)).not.toThrow()
    },
  )
})
