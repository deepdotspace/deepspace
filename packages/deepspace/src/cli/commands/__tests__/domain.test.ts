import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import domain from '../domain'
import * as auth from '../../auth'
import * as target from '../../lib/app-target'
import * as api from '../../lib/api'
const APP = 'app_0000000000000000000000HPK1'
let stdout: string[]
beforeEach(() => {
  stdout = []
  vi.spyOn(auth, 'ensureToken').mockResolvedValue('token')
  vi.spyOn(target, 'resolveAppTarget').mockResolvedValue(APP)
  vi.spyOn(console, 'log').mockImplementation((value) => {
    stdout.push(String(value))
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})
async function run(name: string, args: Record<string, unknown>) {
  const commands = domain.subCommands as Record<
    string,
    { run: (ctx: { args: Record<string, unknown> }) => Promise<unknown> }
  >
  await commands[name].run({ args: { domain: 'example.net', json: true, ...args } })
  expect(stdout).toHaveLength(1)
  return JSON.parse(stdout[0])
}
describe('external domain commands', () => {
  it('prepares DNS without entering a checkout or registered-domain lookup', async () => {
    const spy = vi
      .spyOn(api, 'apiFetch')
      .mockResolvedValue({
        domain: { domain: 'example.net', appId: APP, status: 'pending_dns', dnsRecords: [] },
      })
    const output = await run('attach', { external: true })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][2]).toBe('/api/domains/external')
    expect(JSON.parse(spy.mock.calls[0][3]!.body as string)).toEqual({
      domain: 'example.net',
      appId: APP,
    })
    expect(output).toMatchObject({
      ok: true,
      status: 'pending_dns',
      action: { argv: expect.arrayContaining(['verify', 'example.net', '--app', APP]) },
    })
  })
  it('returns DNS records and a retry action while TLS is pending', async () => {
    const dnsRecords = [
      {
        type: 'CNAME',
        name: '_acme-challenge.example.net',
        value: 'example.net.id.dcv.cloudflare.com',
        purpose: 'certificate',
      },
    ]
    vi.spyOn(api, 'apiFetch').mockResolvedValue({
      domain: { domain: 'example.net', appId: APP, status: 'pending_tls', dnsRecords },
    })
    expect(await run('verify', {})).toMatchObject({
      ok: true,
      status: 'pending_tls',
      dnsRecords,
      action: expect.any(Object),
    })
  })
  it('finishes with no retry action when the backend confirms active', async () => {
    vi.spyOn(api, 'apiFetch').mockResolvedValue({
      domain: { domain: 'example.net', appId: APP, status: 'active' },
    })
    const output = await run('verify', {})
    expect(output.status).toBe('active')
    expect(output.action).toBeUndefined()
  })
  it('keeps the existing purchase reattach API', async () => {
    const spy = vi
      .spyOn(api, 'apiFetch')
      .mockResolvedValueOnce({
        domains: [
          { id: 'purchase-id', domain: 'example.net', appId: APP, registrar: 'cloudflare' },
        ],
      })
      .mockResolvedValueOnce({ success: true, appId: APP })
    expect(await run('attach', {})).toMatchObject({ ok: true, domain: 'example.net', appId: APP })
    expect(spy.mock.calls[1][2]).toBe('/api/domains/purchase-id/reattach')
  })
  it('never offers to change renewal for an external registrar', async () => {
    const spy = vi
      .spyOn(api, 'apiFetch')
      .mockResolvedValue({
        domains: [{ id: 'external-id', domain: 'example.net', registrar: 'external' }],
      })
    expect(await run('renew', { auto: 'on' })).toMatchObject({
      ok: false,
      code: 'external_renewal',
    })
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
