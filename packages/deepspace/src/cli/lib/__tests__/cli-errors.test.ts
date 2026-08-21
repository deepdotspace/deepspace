/**
 * Friendly CLI error rendering: escaped errors must surface as one clean
 * message (with known API slugs translated), never a raw stack dump.
 */

import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  formatCliError,
  wrapCommandErrors,
  errorCode,
  failureEnvelope,
  failureExitCode,
  renderCliError,
  InputError,
  Refusal,
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
    expect(out).toContain('Only the app owner can do this.')
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
