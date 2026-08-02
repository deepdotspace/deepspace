/**
 * PLATFORM_URLS (the CLI's per-plane service presets) must name the hosts the
 * workers actually deploy to — env.ts and the four platform wrangler.toml
 * files are two sources of truth with nothing else tying them together. The
 * staging service-zone move (spacestest.com → deepspacesites.com) is exactly
 * the kind of change this pins: every preset had to move in lockstep with
 * four route blocks, by hand.
 *
 * Skips silently if the platform/ tree isn't present (the published package
 * runs its tests standalone); in-repo CI always has it.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PLATFORM_DIR = resolve(import.meta.dirname, '../../../../../platform')
const inRepo = existsSync(PLATFORM_DIR)

/** Hostnames a wrangler file serves: custom-domain patterns + route patterns. */
function servedHosts(worker: string): Set<string> {
  const text = readFileSync(resolve(PLATFORM_DIR, worker, 'wrangler.toml'), 'utf-8')
  const hosts = new Set<string>()
  for (const m of text.matchAll(/^pattern\s*=\s*"([^"]+)"/gm)) {
    hosts.add(m[1].replace(/\/\*$/, '').replace(/\/$/, ''))
  }
  return hosts
}

describe.skipIf(!inRepo)('PLATFORM_URLS ↔ wrangler routes', () => {
  const WORKERS = {
    auth: 'auth-worker',
    api: 'api-worker',
    platform: 'platform-worker',
    deploy: 'deploy-worker',
  } as const

  it.each(Object.entries(WORKERS))('%s presets point at hosts %s actually serves', async (key, worker) => {
    // Import lazily so DEEPSPACE_ENV at module-load time doesn't matter for
    // the rest of the suite; we only need the two literal preset tables.
    const envSrc = readFileSync(resolve(import.meta.dirname, '../env.ts'), 'utf-8')
    const urls = [...envSrc.matchAll(new RegExp(`${key}: 'https://([^']+)'`, 'g'))].map((m) => m[1])
    expect(urls.length, `env.ts should declare a prod and a staging ${key} URL`).toBe(2)
    const hosts = servedHosts(worker)
    for (const url of urls) {
      expect(hosts.has(url), `env.ts names https://${url} but ${worker}/wrangler.toml has no route/custom domain for it`).toBe(true)
    }
  })
})
