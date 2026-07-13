/**
 * Friendly CLI error rendering: escaped errors must surface as one clean
 * message (with known API slugs translated), never a raw stack dump.
 */

import { describe, it, expect } from 'vitest'
import { formatCliError, wrapCommandErrors } from '../cli-errors'
import type { CommandDef } from 'citty'

describe('formatCliError', () => {
  it('passes plain error messages through untouched', () => {
    expect(formatCliError(new Error('Not logged in. Run `deepspace login` first.'))).toBe(
      'Not logged in. Run `deepspace login` first.',
    )
  })

  it('stringifies non-Error throws', () => {
    expect(formatCliError('boom')).toBe('boom')
  })

  it('appends a hint for known API error slugs', () => {
    const out = formatCliError(new Error('API /api/app-collaborators/my-app (403): not_app_owner'))
    expect(out).toContain('not_app_owner')
    expect(out).toContain('Only the app owner can do this.')
  })

  it('explains the lazy-provisioning footgun on user_not_found', () => {
    const out = formatCliError(new Error('API /api/app-collaborators/my-app (404): user_not_found'))
    expect(out).toContain('log in to DeepSpace at least once')
  })

  it('leaves unknown slugs and non-slug API messages as-is', () => {
    const msg = 'API /api/x (500): something exploded badly'
    expect(formatCliError(new Error(msg))).toBe(msg)
    const unknown = 'API /api/x (403): some_future_slug'
    expect(formatCliError(new Error(unknown))).toBe(unknown)
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
