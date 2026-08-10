/**
 * Typo'd flags must be refused, not silently dropped.
 *
 * citty 0.2.2 hardcodes its parser to `strict: false` and exposes no way to
 * change it, so an unknown flag is never rejected — it lands in the parsed
 * object and the command runs with the caller's intent quietly discarded.
 * Observed against the real CLI: `releases --limitt 1` swallowed the flag AND
 * its value and returned every release with exit 0, and `--jsonn` printed
 * human prose to stdout while the caller waited for JSON.
 *
 * Reading those leftovers back out is what lets one check at the shared
 * command boundary cover every verb, with no per-command tables.
 */

import { describe, expect, it } from 'vitest'
import type { ArgsDef } from 'citty'
import { unknownOptionNames, unknownOptionNamesFromRaw } from '../command'

const ARGS: ArgsDef = {
  app: { type: 'string', alias: 'a' },
  limit: { type: 'string' },
  'password-stdin': { type: 'boolean' },
  json: { type: 'boolean' },
}

describe('unknownOptionNames', () => {
  it('accepts declared names, aliases, and positionals', () => {
    expect(
      unknownOptionNames({ _: ['x'], app: 'demo', a: 'demo', limit: '1', json: true }, ARGS),
    ).toEqual([])
  })

  it('accepts both spellings the parser produces for a hyphenated name', () => {
    // mri emits the kebab key AND its camelCase twin; either is legitimate.
    expect(unknownOptionNames({ 'password-stdin': true, passwordStdin: true }, ARGS)).toEqual([])
  })

  it('flags the exact typos that used to run silently', () => {
    expect(unknownOptionNames({ limitt: '1' }, ARGS)).toEqual(['limitt'])
    expect(unknownOptionNames({ jsonn: true }, ARGS)).toEqual(['jsonn'])
    expect(unknownOptionNames({ drynrun: true, bogus: 42 }, ARGS)).toEqual(['drynrun', 'bogus'])
  })

  it('does not flag a boolean passed in negated form', () => {
    // `--no-json` parses to `json: false` — the declared name, not a new one.
    expect(unknownOptionNames({ json: false }, ARGS)).toEqual([])
  })

  it('treats a command with no declared args as accepting none', () => {
    expect(unknownOptionNames({ _: [], anything: true }, {})).toEqual(['anything'])
  })

  it('finds raw typos even when their value would hide a required positional', () => {
    const withRequired: ArgsDef = {
      key: { type: 'positional', required: true },
      app: { type: 'string', alias: 'a' },
      force: { type: 'boolean', default: false },
    }
    expect(unknownOptionNamesFromRaw(['--kay', 'VALUE'], withRequired)).toEqual(['kay'])
    expect(unknownOptionNamesFromRaw(['--app', 'x', '--no-force'], withRequired)).toEqual([])
  })
})
