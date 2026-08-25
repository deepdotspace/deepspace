/**
 * The secrets commands' mid-body refusal guards — pinned at the run() level.
 *
 * A refusal on these paths must STOP the body: the guarded operation is
 * unrecoverable (a destroyed config) or is the very leak the guard exists to
 * prevent (secrets on stdout under a flag that promised JSON). That property
 * only holds while refusals throw to the shared runtime rather than render and
 * return, and no type catches the difference — so each guard is pinned as
 * behavior: ONE envelope, exit 1, and the guarded call never invoked. The lib
 * tests cannot cover it; they never drive a run() body.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandDef } from 'citty'

const secretsLib = vi.hoisted(() => ({
  listSecrets: vi.fn(),
  deleteConfig: vi.fn(),
  getSecretPlain: vi.fn(),
  fetchSecretsValues: vi.fn(),
  uploadSecrets: vi.fn(),
}))

vi.mock('../../lib/secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/secrets')>()
  return { ...actual, ...secretsLib }
})

vi.mock('../../auth', () => ({ ensureToken: async () => 'tok_test' }))

const prompts = vi.hoisted(() => ({ confirm: vi.fn() }))
vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clack/prompts')>()
  return { ...actual, confirm: prompts.confirm }
})

import secrets from '../secrets'
import { wrapCommandErrors } from '../../lib/cli-errors'

const APP = `app_${'1'.repeat(26)}`

type Runnable = { run: (ctx: { args: Record<string, unknown> }) => Promise<unknown> }

// The same wrapper cli.ts puts around the command tree: these bodies THROW
// their refusals now (the per-command `catch (err) { fail(err) }` hop is
// gone), and `wrapCommandErrors` is the one catch that renders them. Driving
// the raw tree would test a shape production never runs.
const secretsCli = wrapCommandErrors(secrets as CommandDef)

function subcommand(path: string[]): Runnable {
  let node: CommandDef = secretsCli
  for (const name of path) {
    node = (node.subCommands as Record<string, CommandDef>)[name]
  }
  return node as unknown as Runnable
}

async function runSecrets(
  path: string[],
  args: Record<string, unknown>,
): Promise<{ stdout: string[]; exitCode: number | undefined }> {
  const stdout: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => stdout.push(String(line)))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout.push(String(chunk))
    return true
  }) as never)
  // renderCliError picks the JSON envelope path off process.argv (the raw
  // invocation), not the parsed args — mirror a real `--json` invocation.
  const argvBefore = process.argv
  if (args.json === true) process.argv = [...argvBefore, '--json']
  process.exitCode = undefined
  try {
    await subcommand(path).run({ args })
  } finally {
    process.argv = argvBefore
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : undefined
  process.exitCode = undefined
  return { stdout, exitCode }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  process.exitCode = undefined
})

describe('secrets configs delete — the guards ahead of an unrecoverable delete', () => {
  it('names the secret count in the prompt, and deletes once consent is given', async () => {
    // The count is the whole point of asking: it says what goes with the
    // config, which is the fact a bare "are you sure?" withholds.
    secretsLib.listSecrets.mockResolvedValue({ secrets: [{ key: 'API_KEY' }, { key: 'DB_URL' }] })
    prompts.confirm.mockResolvedValue(true)
    const isTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    try {
      await runSecrets(['configs', 'delete'], { name: 'production', app: APP, yes: false })

      expect(prompts.confirm).toHaveBeenCalledTimes(1)
      const message = String(prompts.confirm.mock.calls[0]?.[0]?.message)
      expect(message).toContain('holds 2 secrets')
      expect(message).toContain('API_KEY')
      expect(message).toContain('permanently')
      // Consent given ⇒ the delete proceeds.
      expect(secretsLib.deleteConfig).toHaveBeenCalledTimes(1)
    } finally {
      if (isTTY) Object.defineProperty(process.stdin, 'isTTY', isTTY)
      else delete (process.stdin as { isTTY?: unknown }).isTTY
    }
  })

  it('skips the prompt entirely under --yes', async () => {
    secretsLib.listSecrets.mockResolvedValue({ secrets: [{ key: 'API_KEY' }] })

    await runSecrets(['configs', 'delete'], { name: 'production', app: APP, yes: true })

    expect(prompts.confirm).not.toHaveBeenCalled()
    expect(secretsLib.deleteConfig).toHaveBeenCalledTimes(1)
  })

  it('refuses under --json with ONE envelope and never deletes (no prompt hang)', async () => {
    secretsLib.listSecrets.mockResolvedValue({ secrets: [{ key: 'API_KEY' }] })
    const { stdout, exitCode } = await runSecrets(['configs', 'delete'], {
      name: 'production',
      app: APP,
      json: true,
    })
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toMatchObject({ ok: false, code: 'confirmation_required' })
    expect(exitCode).toBe(1)
    expect(secretsLib.deleteConfig).not.toHaveBeenCalled()
    expect(prompts.confirm).not.toHaveBeenCalled()
    // Refused BEFORE the count is fetched: the count only feeds the
    // interactive sentence, so listing first would let a missing config
    // answer this path with the store's error instead of this slug.
    expect(secretsLib.listSecrets).not.toHaveBeenCalled()
  })

  it('still refuses confirmation_required when the config does not exist', async () => {
    secretsLib.listSecrets.mockRejectedValue(
      Object.assign(new Error('Config not found'), { status: 404 }),
    )
    const { stdout, exitCode } = await runSecrets(['configs', 'delete'], {
      name: 'ghost',
      app: APP,
      json: true,
    })
    expect(JSON.parse(stdout[0])).toMatchObject({ ok: false, code: 'confirmation_required' })
    expect(exitCode).toBe(1)
    expect(secretsLib.deleteConfig).not.toHaveBeenCalled()
  })

  it('leaves the config alone when the user answers NO', async () => {
    secretsLib.listSecrets.mockResolvedValue({ secrets: [{ key: 'API_KEY' }] })
    prompts.confirm.mockResolvedValue(false)
    const isTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    try {
      const { exitCode } = await runSecrets(['configs', 'delete'], {
        name: 'production',
        app: APP,
        json: false,
      })
      expect(prompts.confirm).toHaveBeenCalledTimes(1)
      // The one assertion that matters: declining must not delete.
      expect(secretsLib.deleteConfig).not.toHaveBeenCalled()
      expect(exitCode).toBe(1)
    } finally {
      if (isTTY) Object.defineProperty(process.stdin, 'isTTY', isTTY)
      else delete (process.stdin as { isTTY?: unknown }).isTTY
    }
  })
})

describe('secrets output-shape guards refuse BEFORE touching the store', () => {
  it('download --json refuses with one envelope and fetches nothing', async () => {
    const { stdout, exitCode } = await runSecrets(['download'], {
      app: APP,
      json: true,
      format: 'dotenv',
    })
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toMatchObject({ ok: false, code: 'invalid_flags' })
    expect(exitCode).toBe(1)
    expect(secretsLib.fetchSecretsValues).not.toHaveBeenCalled()
  })

  it('get --plain --json refuses with one envelope and never reads the secret', async () => {
    const { stdout, exitCode } = await runSecrets(['get'], {
      key: 'API_KEY',
      app: APP,
      plain: true,
      json: true,
    })
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toMatchObject({ ok: false, code: 'invalid_flags' })
    expect(exitCode).toBe(1)
    expect(secretsLib.getSecretPlain).not.toHaveBeenCalled()
  })

  it('upload with a missing file emits ONE coded envelope, not a second raw errno', async () => {
    const { stdout, exitCode } = await runSecrets(['upload'], {
      file: '/definitely/not/here.env',
      app: APP,
      json: true,
    })
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toMatchObject({ ok: false, code: 'file_not_found' })
    expect(exitCode).toBe(1)
    expect(secretsLib.uploadSecrets).not.toHaveBeenCalled()
  })
})
