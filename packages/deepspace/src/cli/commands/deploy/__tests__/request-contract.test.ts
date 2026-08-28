/**
 * Pins on the deploy request module's cross-service contracts: the capability
 * handshake (the one thing standing between a new CLI and a pre-cutover
 * server stripping every live user secret from an owner deploy), and the
 * error classifier's
 * platform-refusal allowlist (codes whose message must never be dressed as a
 * Cloudflare incident).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatDeployWorkerError, requireDeployCapabilities } from '../request'
import { secretsConfigCreateAction } from '../secrets'
import { unavailableDoGuardRefusal } from '../../rollback'
import type { DeployOutput } from '../output'

class Died extends Error {
  constructor(readonly code: string) {
    super(`died:${code}`)
  }
}

/** die() that throws so the test can observe the refusal code. */
function fakeOutput(): DeployOutput {
  return {
    die: (_message: string, code: string) => {
      throw new Died(code)
    },
  } as unknown as DeployOutput
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('deploy wire field names (source pin)', () => {
  it('the form names the secrets config with the field the server dispatches on', () => {
    // input.ts dispatches on the literal 'secretsConfig'; renaming the CLI
    // side would pass every unit suite and only surface as a runtime 410.
    const source = readFileSync(fileURLToPath(new URL('../request.ts', import.meta.url)), 'utf8')
    expect(source).toContain("form.append('secretsConfig', secretsConfig)")
  })
})

describe('commit-race secrets_config_missing backstop (source pin)', () => {
  // The backstop lives mid-deployBuiltBundle where a unit drive is heavy, so
  // pin its two load-bearing properties at the source level: the CLI renders
  // its OWN sentence (the server's body.error prose cannot know the wrangler
  // env), and the executable action carries --env.
  it('renders its own sentence and an env-aware action', () => {
    const source = readFileSync(fileURLToPath(new URL('../request.ts', import.meta.url)), 'utf8')
    const start = source.indexOf("body.code === 'secrets_config_missing'")
    expect(start).toBeGreaterThan(-1)
    const block = source.slice(start, start + 1200)
    // Positive half: the bail message is OUR template literal. Negative
    // half: no fallback chain hands the server's env-blind prose through
    // (the rationale comment itself names body.error, so match usage).
    expect(block).toMatch(/bail\(\s*`Secrets config "/)
    expect(block).not.toMatch(/body\.error\s*(\?\?|\|\|)/)
    // The action comes from the ONE shared builder (deploy/secrets.ts) so
    // the backstop and the pre-deploy check cannot drift.
    expect(block).toMatch(/secretsConfigCreateAction\(appDir,\s*secretsConfig,\s*envName\)/)
  })
})

describe('secretsConfigCreateAction', () => {
  it('is env-aware: --env rides exactly when an env is set', () => {
    expect(secretsConfigCreateAction('/app', 'prd', 'staging')).toEqual({
      cwd: '/app',
      argv: ['deepspace', 'secrets', 'configs', 'create', 'prd', '--env', 'staging'],
    })
    expect(secretsConfigCreateAction('/app', 'prd', undefined)).toEqual({
      cwd: '/app',
      argv: ['deepspace', 'secrets', 'configs', 'create', 'prd'],
    })
  })
})

describe('requireDeployCapabilities', () => {
  function stubHealth(body: unknown, ok = true) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (ok ? Response.json(body) : new Response('', { status: 503 }))),
    )
  }

  it('passes when the server advertises both required capabilities', async () => {
    stubHealth({
      capabilities: { assetTransport: 'content-addressed-v1', secretsSource: 'store-read-v1' },
    })
    await expect(
      requireDeployCapabilities('https://deploy.test', null, fakeOutput()),
    ).resolves.toBeUndefined()
  })

  it('the probe is retried and bounded — one 503 blip is not a refusal', async () => {
    // postWithRetry wiring, pinned: a bare fetch here would refuse on the
    // first transient 503 (and, unbounded, ride undici's ~5-minute default
    // against a hung service). Two calls prove the retry path is live.
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      requireDeployCapabilities('https://deploy.test', null, fakeOutput()),
    ).rejects.toMatchObject({ code: 'deploy_service_unreachable' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('scopes the pin-the-old-CLI hint to the secretsSource arm only', async () => {
    // deepspace@0.23 requires assetTransport just the same, so suggesting the
    // pin for a missing asset transport would send users to a CLI that also
    // fails. The hint belongs to the secretsSource arm alone.
    const messages: string[] = []
    const output = {
      die: (message: string, code: string) => {
        messages.push(message)
        throw new Died(code)
      },
    } as unknown as DeployOutput

    stubHealth({ capabilities: { secretsSource: 'store-read-v1' } })
    await expect(
      requireDeployCapabilities('https://deploy.test', null, output),
    ).rejects.toMatchObject({ code: 'asset_transport_unsupported' })
    expect(messages[0]).not.toContain('deepspace@0.23')

    stubHealth({ capabilities: { assetTransport: 'content-addressed-v1' } })
    await expect(
      requireDeployCapabilities('https://deploy.test', null, output),
    ).rejects.toMatchObject({ code: 'secrets_source_unsupported' })
    expect(messages[1]).toContain('deepspace@0.23')
  })

  it('dies secrets_source_unsupported against a pre-cutover server', async () => {
    // Without this refusal, a new CLI would deploy with no `userSecrets`
    // field and the old server would upload no secret bindings at all —
    // stripping EVERY live user secret behind a green owner deploy (only
    // on-behalf deploys keep_bindings the existing ones).
    stubHealth({ capabilities: { assetTransport: 'content-addressed-v1' } })
    await expect(
      requireDeployCapabilities('https://deploy.test', null, fakeOutput()),
    ).rejects.toMatchObject({ code: 'secrets_source_unsupported' })
  })

  it('dies deploy_service_unreachable when health cannot be read', async () => {
    stubHealth(null, false)
    await expect(
      requireDeployCapabilities('https://deploy.test', null, fakeOutput()),
    ).rejects.toMatchObject({ code: 'deploy_service_unreachable' })
  })
})

describe('formatDeployWorkerError', () => {
  it("passes platform refusals through verbatim — they are not Cloudflare's fault", () => {
    for (const code of ['cli_outdated', 'secrets_read_failed', 'release_reconciliation_pending']) {
      expect(formatDeployWorkerError(503, 'The platform said exactly this.', code)).toBe(
        'The platform said exactly this.',
      )
    }
  })

  it('still wraps an uncoded 5xx in the incident hint', () => {
    const rendered = formatDeployWorkerError(503, 'Worker deploy failed', undefined)
    expect(rendered).toContain('Underlying error: Worker deploy failed')
    expect(rendered).not.toBe('Worker deploy failed')
  })
})

describe('unavailableDoGuardRefusal', () => {
  it('surfaces the server-supplied cause on its own line', () => {
    const refusal = unavailableDoGuardRefusal(
      'Could not verify.',
      'Cloudflare bindings read failed (403)',
    )
    expect(refusal.message).toContain('Cause: Cloudflare bindings read failed (403)')
    expect(refusal.code).toBe('do_guard_unavailable')
  })

  it('omits the cause line when the server sent none', () => {
    const refusal = unavailableDoGuardRefusal('Could not verify.')
    expect(refusal.message).not.toContain('Cause:')
  })
})
