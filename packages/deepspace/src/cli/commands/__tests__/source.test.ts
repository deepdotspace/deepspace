import { afterEach, describe, expect, it, vi } from 'vitest'
import source from '../source'
import * as authModule from '../../auth'
import * as appTarget from '../../lib/app-target'
import * as sourceApi from '../../lib/source-api'

const APP_ID = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'

afterEach(() => {
  vi.restoreAllMocks()
  // Clear the exit code the runtime records, so a refusal-path test cannot
  // poison the vitest worker's own exit code.
  process.exitCode = undefined
})

async function runSourceJson(args: Record<string, unknown> = {}) {
  const logs: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
  const command = source as unknown as {
    run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
  }
  process.exitCode = undefined
  await command.run({ args: { json: true, ...args } })
  return {
    output: JSON.parse(logs[0]) as Record<string, unknown>,
    exit: process.exitCode,
  }
}

function arrange(current: sourceApi.AppSource | null, revision = 3) {
  vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
  vi.spyOn(appTarget, 'resolveAppTarget').mockResolvedValue(APP_ID)
  vi.spyOn(sourceApi, 'getAppSource').mockResolvedValue({
    appId: APP_ID,
    source: current,
    revision,
    registered: true,
  })
}

describe('app source is a read-only report', () => {
  it('reports a GitHub-source app', async () => {
    arrange({ provider: 'github', repository: 'deepspacerepos/source-test' }, 4)
    const { output, exit } = await runSourceJson()
    expect(output).toMatchObject({
      ok: true,
      appId: APP_ID,
      source: { provider: 'github', repository: 'deepspacerepos/source-test' },
      revision: 4,
      registered: true,
    })
    expect(exit).toBe(0)
  })

  it('reports a DeepSpace-source app', async () => {
    arrange({ provider: 'deepspace' }, 2)
    const { output, exit } = await runSourceJson()
    expect(output).toMatchObject({ ok: true, source: { provider: 'deepspace' }, revision: 2 })
    expect(exit).toBe(0)
  })

  it('reports unclaimed as a state, not a problem', async () => {
    arrange(null, 0)
    const { output, exit } = await runSourceJson()
    expect(output).toMatchObject({ ok: true, source: null, revision: 0 })
    expect(exit).toBe(0)
  })

  it('refuses the old setter with source_inferred and touches nothing', async () => {
    // Source is never declared: a GitHub checkout deploys as GitHub by
    // inference, and the first `deepspace push` claims DeepSpace source at
    // the git receive path. The refusal teaches the model instead of
    // pretending a declaration still exists.
    arrange(null, 0)
    const getSource = vi.spyOn(sourceApi, 'getAppSource')
    const { output, exit } = await runSourceJson({ provider: 'github' })
    expect(output).toMatchObject({ ok: false, code: 'source_inferred' })
    expect(String(output.error)).toContain('deepspace push')
    expect(getSource).not.toHaveBeenCalled()
    expect(exit).toBe(1)
  })
})
