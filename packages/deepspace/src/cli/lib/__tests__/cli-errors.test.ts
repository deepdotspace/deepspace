/**
 * Friendly CLI error rendering: escaped errors must surface as one clean
 * message (with known API slugs translated), never a raw stack dump.
 */

import { describe, it, expect } from 'vitest'
import { formatCliError, wrapCommandErrors, errorCode, InputError } from '../cli-errors'
import { ApiError } from '../api'
import type { CommandDef } from 'citty'

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
