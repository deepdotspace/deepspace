/**
 * `deepspace secrets` renders through the shared error renderer like every
 * other command: a logged-out, offline, uninitialized, or bad-argument state
 * carries the same `code` (and `action`) its sibling commands ship — these
 * four were the refusals that used to leave `--json` without a code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import secrets from '../secrets'
import * as authModule from '../../auth'
import * as appContext from '../../lib/app-context'
import { Refusal, renderCliError } from '../../lib/cli-errors'

const APP_ID = 'app_01JG8QK4M2N7P9RSTVWXYZ0123'

let dir: string | undefined
let argv: string[]

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  process.exitCode = undefined
  process.argv = argv
  vi.useRealTimers()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function appWith(wranglerToml: string): string {
  dir = mkdtempSync(join(tmpdir(), 'ds-secrets-'))
  writeFileSync(join(dir, 'wrangler.toml'), wranglerToml)
  return dir
}

async function runJson(
  sub: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  argv = process.argv
  process.argv = [...argv, '--json']
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const command = (
    secrets.subCommands as Record<
      string,
      { run: (ctx: { args: Record<string, unknown> }) => Promise<unknown> }
    >
  )[sub]
  // A plain citty command: cli.ts wraps it so escaped errors reach the
  // shared renderer — do the same here.
  await command.run({ args: { json: true, ...args } }).catch(renderCliError)
  return JSON.parse(lines[0]) as Record<string, unknown>
}

describe('secrets refusals carry codes', () => {
  it('logged out → not_authenticated with the login action every sibling ships', async () => {
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(
      appWith(`name = "x"\n[vars]\nDEEPSPACE_APP_ID = "${APP_ID}"\n`),
    )
    vi.spyOn(authModule, 'ensureToken').mockRejectedValue(
      new Refusal('Not logged in on production.', 'not_authenticated', {
        action: { cwd: process.cwd(), argv: ['deepspace', 'auth', 'login'] },
      }),
    )
    expect(await runJson('list', {})).toMatchObject({
      ok: false,
      code: 'not_authenticated',
      error: 'Not logged in on production.',
      action: { argv: ['deepspace', 'auth', 'login'] },
    })
    expect(process.exitCode).toBe(1)
  })

  it('network down → network_error naming the deploy service, its URL and DEEPSPACE_DEPLOY_URL', async () => {
    vi.useFakeTimers()
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(
      appWith(`name = "x"\n[vars]\nDEEPSPACE_APP_ID = "${APP_ID}"\n`),
    )
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('tok')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    const request = runJson('list', {})
    await vi.runAllTimersAsync()
    const out = await request
    expect(out).toMatchObject({ ok: false, code: 'network_error' })
    expect(String(out.error)).toMatch(/Could not reach the deploy service at https?:\/\//)
    expect(String(out.error)).toContain('DEEPSPACE_DEPLOY_URL')
  })

  it('in an app with no id yet → app_not_initialized with the `app init` action, like deploy', async () => {
    const appDir = appWith('name = "x"\n[vars]\nDEEPSPACE_APP_ID = "__APP_ID__"\n')
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(appDir)
    const ensure = vi.spyOn(authModule, 'ensureToken').mockResolvedValue('tok')
    expect(await runJson('list', {})).toMatchObject({
      ok: false,
      code: 'app_not_initialized',
      actionRequired: true,
      action: { cwd: appDir, argv: ['deepspace', 'app', 'init'] },
    })
    expect(process.exitCode).toBe(2)
    expect(ensure).not.toHaveBeenCalled()
  })

  it('a malformed id → invalid_app_id (never "no app id")', async () => {
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(
      appWith('name = "x"\n[vars]\nDEEPSPACE_APP_ID = "not-an-app-id"\n'),
    )
    const out = await runJson('list', {})
    expect(out).toMatchObject({ ok: false, code: 'invalid_app_id' })
    expect(String(out.error)).toContain('"not-an-app-id"')
    expect(out.action).toBeUndefined()
  })

  it('outside any app → not_in_app_repo', async () => {
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(null)
    expect(await runJson('list', {})).toMatchObject({ ok: false, code: 'not_in_app_repo' })
  })

  it('upload <missing file> → file_not_found, not a raw ENOENT', async () => {
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(
      appWith(`name = "x"\n[vars]\nDEEPSPACE_APP_ID = "${APP_ID}"\n`),
    )
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('tok')
    const out = await runJson('upload', { file: 'PROBE_SECRET', replace: false })
    expect(out).toMatchObject({ ok: false, code: 'file_not_found' })
    expect(String(out.error)).toContain('No such file: PROBE_SECRET')
    expect(String(out.error)).not.toContain('ENOENT')
  })
})

describe('secrets upload -', () => {
  function stubStdin(chunks: string[]): void {
    let index = 0
    const stream = new Readable({
      read() {
        setTimeout(() => this.push(index < chunks.length ? chunks[index++] : null), 1)
      },
    })
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stream as unknown as typeof process.stdin)
  }

  it('waits for a genuine streaming pipe instead of throwing EAGAIN', async () => {
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('tok')
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true, updated: ['ONE', 'TWO'] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    stubStdin(['ONE=1\n', 'TW', 'O=2\n'])

    const out = await runJson('upload', { app: APP_ID, file: '-', replace: false })

    expect(out).toMatchObject({ ok: true, uploaded: ['ONE', 'TWO'] })
    const request = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined
    expect(JSON.parse(String(request?.body))).toMatchObject({ secrets: { ONE: '1', TWO: '2' } })
  })

  it('refuses a terminal instead of waiting forever', async () => {
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('tok')
    const terminal = Object.assign(new Readable({ read() {} }), { isTTY: true })
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(terminal as unknown as typeof process.stdin)

    expect(await runJson('upload', { app: APP_ID, file: '-', replace: false })).toMatchObject({
      ok: false,
      code: 'no_stdin',
    })
  })
})

describe('secret mutation retries', () => {
  it('retries an idempotent set after a transient connection failure', async () => {
    vi.useFakeTimers()
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('tok')
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const result = runJson('set', { app: APP_ID, secret: 'AWS_REGION=us-east-1' })
    await vi.runAllTimersAsync()

    await expect(result).resolves.toMatchObject({ ok: true, set: ['AWS_REGION'] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('counts a replay-safe absent delete without claiming a deletion', async () => {
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('tok')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, key: 'MISSING_KEY', deleted: false })),
    )

    await expect(runJson('delete', { app: APP_ID, key: 'MISSING_KEY' })).resolves.toMatchObject({
      ok: true,
      deleted: 0,
      absent: 1,
    })
  })
})
