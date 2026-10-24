import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { syncOneTimeProducts, validateAgentCommerce } from '../commerce'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-commerce-'))
  mkdirSync(join(dir, 'src'))
  vi.stubEnv('DEEPSPACE_AGENT_CREDENTIAL_FILE', '/private/identity.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
it('does not call payment APIs for an empty agent catalog', async () => {
  writeFileSync(join(dir, 'src/products.ts'), 'export const oneTimeProducts = []')
  await validateAgentCommerce(dir)
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await syncOneTimeProducts(dir, 'app_one', 'token')
  expect(fetch).not.toHaveBeenCalled()
})
it.each([
  ['products.ts', 'oneTimeProducts'],
  ['subscriptions.ts', 'subscriptionPlans'],
])('refuses paid declarations in %s before deployment', async (file, key) => {
  writeFileSync(join(dir, 'src', file), `export const ${key} = [{ productId: 'paid' }]`)
  await expect(validateAgentCommerce(dir)).rejects.toMatchObject({
    code: 'agent_capability_unavailable',
  })
})
it('still sends empty human catalogs to deactivate removed products', async () => {
  delete process.env.DEEPSPACE_AGENT_CREDENTIAL_FILE
  writeFileSync(join(dir, 'src/products.ts'), 'export const oneTimeProducts = []')
  const fetch = vi.fn(async () => Response.json({ ok: true, count: 0 }))
  vi.stubGlobal('fetch', fetch)
  await syncOneTimeProducts(dir, 'app_one', 'token')
  expect(fetch).toHaveBeenCalledTimes(1)
})
