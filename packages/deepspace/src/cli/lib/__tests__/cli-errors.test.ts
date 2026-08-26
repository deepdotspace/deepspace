/**
 * Friendly CLI error rendering: escaped errors must surface as one clean
 * message (with known API slugs translated), never a raw stack dump.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

// renderCliError prints its human line with console.error and its `Next:`
// line through @clack/prompts; capture both so "rendered exactly once" is a
// property the test can actually see.
const logStub = vi.hoisted(() => ({ message: vi.fn(), error: vi.fn(), warn: vi.fn() }))
vi.mock('@clack/prompts', () => ({
  log: logStub,
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}))

import {
  CliExit,
  formatCliError,
  renderCliError,
  wrapCommandErrors,
  errorCode,
  failureEnvelope,
  failureExitCode,
  InputError,
  Refusal,
  isMissingCwdError,
} from '../cli-errors'
import { ApiError } from '../api'
import type { CommandDef } from 'citty'

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('formatCliError', () => {
  it('passes plain error messages through untouched', () => {
    expect(formatCliError(new Error('Not logged in. Run `deepspace auth login` first.'))).toBe(
      'Not logged in. Run `deepspace auth login` first.',
    )
  })

  it('stringifies non-Error throws', () => {
    expect(formatCliError('boom')).toBe('boom')
  })

  it('appends a hint for known API error slugs', () => {
    const out = formatCliError(new ApiError('You do not own this app.', 403, 'not_app_owner'))
    expect(out).toContain('You do not own this app.')
    // The hint names the recoveries, not just the fact (2026-08-25 AX pass:
    // three call sites answered with the bare sentence and no way forward).
    expect(out).toContain('app transfer offer')
    expect(out).toContain('app init --new-id')
  })

  it('explains the lazy-provisioning footgun on user_not_found', () => {
    const out = formatCliError(new ApiError('User not found.', 404, 'user_not_found'))
    expect(out).toContain('log in to DeepSpace at least once')
  })

  it('leaves unknown slugs and plain messages as-is', () => {
    const msg = 'Something exploded badly.'
    expect(formatCliError(new Error(msg))).toBe(msg)
    expect(formatCliError(new ApiError('A future failure.', 403, 'some_future_slug'))).toBe(
      'A future failure.',
    )
  })
})

describe('wrapCommandErrors', () => {
  it('wraps run() on the command and every nested subcommand', async () => {
    const calls: string[] = []
    const cmd = {
      meta: { name: 'root' },
      run: () => {
        calls.push('root')
      },
      subCommands: {
        child: {
          meta: { name: 'child' },
          run: () => {
            calls.push('child')
          },
          subCommands: {
            grandchild: {
              meta: { name: 'grandchild' },
              run: () => {
                calls.push('grandchild')
              },
            },
          },
        },
      },
    } as unknown as CommandDef

    const wrapped = wrapCommandErrors(cmd)
    // Wrapped handlers still invoke the original run.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapped.run as any)({})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subs = wrapped.subCommands as any
    await subs.child.run({})
    await subs.child.subCommands.grandchild.run({})
    expect(calls).toEqual(['root', 'child', 'grandchild'])
  })
})

describe('errorCode', () => {
  it('reads the machine code from an ApiError (server failure)', () => {
    expect(errorCode(new ApiError('nope', 403, 'not_app_owner'))).toBe('not_app_owner')
  })

  it('reads the machine code from an InputError (client-side validation)', () => {
    expect(errorCode(new InputError('--app was given an empty app id.', 'invalid_app'))).toBe('invalid_app')
  })

  it('returns undefined for a plain Error, a non-error, or a foreign .code (no leakage)', () => {
    expect(errorCode(new Error('boom'))).toBeUndefined()
    expect(errorCode('boom')).toBeUndefined()
    expect(errorCode(undefined)).toBeUndefined()
    // A Node fs error carries a string .code (ENOENT) but must NOT leak into the
    // machine contract as though it were a documented code.
    expect(errorCode(Object.assign(new Error('nope'), { code: 'ENOENT' }))).toBeUndefined()
  })
})

describe('a vanished working directory is diagnosed, not leaked as an errno', () => {
  it('maps the uv_cwd ENOENT to worktree_missing with a message naming the fix', () => {
    const err = Object.assign(new Error('ENOENT: no such file or directory, uv_cwd'), {
      code: 'ENOENT',
      syscall: 'uv_cwd',
    })
    expect(isMissingCwdError(err)).toBe(true)
    expect(errorCode(err)).toBe('worktree_missing')
    const message = formatCliError(err)
    expect(message).toMatch(/no longer exists/i)
    expect(message).not.toMatch(/uv_cwd/)
    // It must not assert a cause it has not established — every verb answers
    // this, including ones with nothing to do with version control.
    expect(message).not.toMatch(/most likely a workspace worktree/i)
  })

  it('does NOT claim a missing FILE is a missing working directory', () => {
    // The old check also matched the message text, so any path containing
    // `uv_cwd` — a directory someone happened to name that — was reported as
    // a vanished cwd with prune advice.
    const err = Object.assign(
      new Error("ENOENT: no such file or directory, open '/tmp/uv_cwd/config.json'"),
      { code: 'ENOENT', syscall: 'open', path: '/tmp/uv_cwd/config.json' },
    )
    expect(isMissingCwdError(err)).toBe(false)
    expect(errorCode(err)).toBeUndefined()
  })
})

describe('errorCode stays deliberately narrow', () => {
  it('does not invent a code for an ordinary Error', () => {
    expect(errorCode(new Error('something went wrong'))).toBeUndefined()
  })
})

describe('renderCliError renders exactly once', () => {
  const origExitCode = process.exitCode
  let stderr: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    stderr.mockRestore()
    logStub.message.mockClear()
    process.exitCode = origExitCode
  })

  it('records a CliExit code without a second rendering', () => {
    // A CliExit was already fully rendered by its thrower (deploy's
    // die()/bail()); it carries only the exit code. Rendering it again would
    // print the failure twice — and print `exit 2` as if it were the message.
    renderCliError(new CliExit(2))
    expect(process.exitCode).toBe(2)
    expect(stderr).not.toHaveBeenCalled()
    expect(logStub.message).not.toHaveBeenCalled()
  })

  it('prints one message and at most one `Next:` for a refusal with an action', () => {
    // The action is emitted here AND by the command runtime's own catch; only
    // one of the two paths ever runs for a given error, so a caller must never
    // see the recovery twice.
    const refusal = new Refusal('Local branch is behind.', 'non_fast_forward', {
      action: { cwd: '/app', argv: ['deepspace', 'pull'] },
      actionRequired: true,
    })
    renderCliError(refusal)
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(String(stderr.mock.calls[0][0])).toContain('[non_fast_forward]')
    expect(logStub.message).toHaveBeenCalledTimes(1)
    expect(String(logStub.message.mock.calls[0][0])).toContain('Next:')
    // actionRequired + a reachable action is the exit-2 tier.
    expect(process.exitCode).toBe(2)
  })

  it('prints no `Next:` when the refusal carries no action', () => {
    renderCliError(new InputError('Blank --app.', 'invalid_app'))
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(logStub.message).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})

describe('renderCliError’s --json branch', () => {
  const origExitCode = process.exitCode
  const origArgv = process.argv
  let stdout: ReturnType<typeof vi.spyOn>
  let stderr: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Under vitest, argv never contains `--json`, so this whole branch — the
    // fallback envelope for the ~15 commands that do not catch their own
    // errors — was never executed by any test.
    process.argv = ['node', 'cli.js', 'push', '--json']
    stdout = vi.spyOn(console, 'log').mockImplementation(() => {})
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.argv = origArgv
    stdout.mockRestore()
    stderr.mockRestore()
    logStub.message.mockClear()
    process.exitCode = origExitCode
  })

  it('emits one envelope on stdout with code, action and the exit-2 tier', () => {
    const refusal = new Refusal('Local branch is behind.', 'non_fast_forward', {
      action: { cwd: '/app', argv: ['deepspace', 'pull'] },
      actionRequired: true,
      extra: { branch: 'main', ok: true },
    })
    renderCliError(refusal)

    expect(stdout).toHaveBeenCalledTimes(1)
    const envelope = JSON.parse(String(stdout.mock.calls[0][0])) as Record<string, unknown>
    expect(envelope).toMatchObject({
      ok: false,
      code: 'non_fast_forward',
      actionRequired: true,
      error: 'Local branch is behind.',
      action: { cwd: '/app', argv: ['deepspace', 'pull'] },
      branch: 'main',
    })
    // The reserved-key guard applies on this path too: `extra.ok` must not
    // have flipped the envelope to success.
    expect(envelope.ok).toBe(false)
    expect(process.exitCode).toBe(2)
    // Machine path only: no human line, no `Next:`.
    expect(stderr).not.toHaveBeenCalled()
    expect(logStub.message).not.toHaveBeenCalled()
  })

  it('exits 1 and carries the code for a plain refusal', () => {
    renderCliError(new InputError('Blank --app.', 'invalid_app'))
    const envelope = JSON.parse(String(stdout.mock.calls[0][0])) as Record<string, unknown>
    expect(envelope).toEqual({ ok: false, code: 'invalid_app', error: 'Blank --app.' })
    expect(process.exitCode).toBe(1)
  })

  it('still records a CliExit code without emitting a second document', () => {
    renderCliError(new CliExit(2))
    expect(stdout).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(2)
  })
})

describe('Refusal through the escaped-error renderer', () => {
  const refusal = () =>
    new Refusal('No app id in /app/wrangler.toml. Run `deepspace app init`.', 'app_not_initialized', {
      action: { cwd: '/app', argv: ['deepspace', 'app', 'init'] },
      actionRequired: true,
      extra: { appDir: '/app' },
    })

  it('errorCode reads a Refusal\'s code, so shared helpers may throw one into any command', () => {
    expect(errorCode(refusal())).toBe('app_not_initialized')
  })

  it('failureEnvelope carries code, actionRequired, action and extra — the runtime envelope', () => {
    expect(failureEnvelope(refusal())).toEqual({
      ok: false,
      code: 'app_not_initialized',
      actionRequired: true,
      error: 'No app id in /app/wrangler.toml. Run `deepspace app init`.',
      action: { cwd: '/app', argv: ['deepspace', 'app', 'init'] },
      appDir: '/app',
    })
    expect(failureExitCode(refusal())).toBe(2)
    expect(failureExitCode(new InputError('x', 'y'))).toBe(1)
  })

  it('renderCliError --json emits that envelope and exit 2 (a citty command loses nothing)', () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
    const argv = process.argv
    process.argv = [...argv, '--json']
    try {
      renderCliError(refusal())
    } finally {
      process.argv = argv
    }
    expect(JSON.parse(lines[0])).toMatchObject({
      ok: false,
      code: 'app_not_initialized',
      actionRequired: true,
      action: { cwd: '/app', argv: ['deepspace', 'app', 'init'] },
    })
    expect(process.exitCode).toBe(2)
  })

  it('renderCliError (human) prints the slugged line and the Next: action', () => {
    const errs: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => errs.push(String(line)))
    const argv = process.argv
    process.argv = argv.filter((a) => a !== '--json')
    try {
      renderCliError(new Refusal('Not logged in.', 'not_authenticated', {
        action: { cwd: '/app', argv: ['deepspace', 'auth', 'login'] },
      }))
    } finally {
      process.argv = argv
    }
    expect(errs[0]).toBe('Not logged in. [not_authenticated]')
    expect(process.exitCode).toBe(1)
  })
})
