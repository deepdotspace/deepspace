import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureToken: vi.fn(async () => 'token'),
  resolveAppSelector: vi.fn(async (_url: string, _token: string, app: string) => app),
}))

vi.mock('../../auth', () => ({ ensureToken: mocks.ensureToken }))
vi.mock('../../lib/app-target', () => ({ resolveAppSelector: mocks.resolveAppSelector }))

import undeploy from '../undeploy'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  mocks.ensureToken.mockClear()
  mocks.resolveAppSelector.mockClear()
})

describe('undeploy partial failure', () => {
  it('returns the exact retry action when registry takedown remains', async () => {
    const appId = 'app_01HZXYABCDEFGHJKMNPQRSTVWX'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: 'The cloud script was removed, but registry takedown failed.',
            code: 'registry_takedown_failed',
            partial: true,
          },
          { status: 503 },
        ),
      ),
    )
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`)
    }) as never)

    const command = undeploy as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    await expect(command.run({ args: { name: appId, json: true } })).rejects.toThrow('exit:2')

    expect(JSON.parse(lines[0])).toMatchObject({
      ok: false,
      code: 'registry_takedown_failed',
      actionRequired: true,
      appId,
      action: {
        cwd: process.cwd(),
        argv: ['deepspace', 'app', 'undeploy', appId],
      },
    })
  })
})
