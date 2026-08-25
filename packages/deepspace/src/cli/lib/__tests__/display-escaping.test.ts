/**
 * Escaping at the output exits, not at the call sites.
 *
 * Peer-authored text — a workspace task, a branch name, git's own stderr, a
 * server sentence — reaches a terminal through a small number of exits: the
 * `Refusal`/`InputError`/`ApiError`/`GitError` constructors, the spinner
 * wrapper, and `printAction`'s argument rendering. Escaping at those exits is
 * what makes the rule checkable: fixing it sink-by-sink leaves the next new
 * sink raw, and leaves nothing to assert.
 *
 * This file covers the LIB exits only. The command-side seams carry their own
 * tests beside the commands that own them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const spinnerStub = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }))
const logStub = vi.hoisted(() => ({ message: vi.fn() }))
vi.mock('@clack/prompts', () => ({ spinner: () => spinnerStub, log: logStub }))

import { ApiError } from '../api'
import { InputError } from '../cli-errors'
import { GitError } from '../git/process'
import { Refusal } from '../command'
import { createSpinner } from '../spinner'
import { printAction } from '../output'

/** Every character class that reorders or hides, minus the two joiners. */
const RLO = String.fromCodePoint(0x202e) // right-to-left override
const WJ = String.fromCodePoint(0x2060) // word joiner
const ALM = String.fromCodePoint(0x61c) // arabic letter mark
const TAG = String.fromCodePoint(0xe0041) // astral tag block
const ESC = String.fromCodePoint(0x1b)
const ZWJ = String.fromCodePoint(0x200d)
const ZWNJ = String.fromCodePoint(0x200c)

/** No format character may survive to the terminal (ZWJ/ZWNJ excepted). */
function rawFormatChars(value: string): string[] {
  return [...value]
    .filter((ch) => /\p{Cf}/u.test(ch) && ch !== ZWNJ && ch !== ZWJ)
    .map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`)
}

const origIsTTY = process.stdout.isTTY
afterEach(() => {
  Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true })
  spinnerStub.start.mockClear()
  spinnerStub.stop.mockClear()
  spinnerStub.message.mockClear()
  logStub.message.mockClear()
})

describe('the refusal exit', () => {
  it('escapes the `--json` error string, which IS the refusal message', () => {
    // The human line and the envelope's `error` are the same string, so one
    // escape closes both — and this asserts they have not drifted apart.
    const refusal = new Refusal(`--into ${RLO}main does not exist`, 'no_target_branch')
    const envelope = JSON.stringify({ ok: false, code: refusal.code, error: refusal.message })
    expect(rawFormatChars(envelope)).toEqual([])
    expect(JSON.parse(envelope).error).toBe(refusal.message)
  })

  it('applies to InputError too — the other half of the same envelope', () => {
    expect(rawFormatChars(new InputError(`--app ${RLO}x is not valid`, 'bad_app').message)).toEqual(
      [],
    )
  })

  it('keeps a multi-line refusal readable', () => {
    const refusal = new Refusal(`line one ${RLO}\nline two\nline three`, 'x')
    expect(refusal.message.split('\n')).toHaveLength(3)
    expect(rawFormatChars(refusal.message)).toEqual([])
  })
})

describe('the exits a chokepoint at Refusal alone does not cover', () => {
  it('escapes ApiError — server prose reaches the terminal through formatCliError', () => {
    // This class bypasses the Refusal/InputError constructors entirely:
    // `formatCliError` prints `err.message` verbatim and puts it in the
    // `--json` envelope.
    const err = new ApiError(`secret in ${RLO}a.env`, 409, 'secret_in_history')
    expect(rawFormatChars(err.message)).toEqual([])
  })

  it('escapes GitError — git stderr carries ref names the pusher chose', () => {
    expect(rawFormatChars(new GitError(`fatal: bad ref ${WJ}feat`, 'git_error').message)).toEqual([])
  })

  it('escapes every spinner message, progress and OUTCOME alike', () => {
    // Escaping progress lines at their call sites and leaving the outcome
    // line raw is the split this exit removes: both go through one wrapper.
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    const spin = createSpinner()
    spin.start(`Checking ${RLO}feat before push…`)
    spin.message(`Uploading ${TAG}feat…`)
    spin.stop(`Pushed ${ALM}feat ${ESC}[2K.`)
    for (const call of [spinnerStub.start, spinnerStub.message, spinnerStub.stop]) {
      const rendered = String(call.mock.calls[0][0])
      expect(rawFormatChars(rendered)).toEqual([])
      expect(rendered).not.toContain(ESC)
    }
  })

  it('sanitises an action argument BEFORE shell-quoting it', () => {
    // Quoting alone does not help: U+202E reorders the printed `Next:` line
    // while the argv it renders is unchanged, so the line and the action the
    // agent executes disagree.
    printAction({ cwd: process.cwd(), argv: ['git', 'checkout', `${RLO}feat`] })
    const line = String(logStub.message.mock.calls[0][0])
    expect(rawFormatChars(line)).toEqual([])
    expect(line).toContain('\\u{202e}')
  })

  it('leaves the joiners alone — they are orthography, not attack surface', () => {
    for (const legit of [`x${ZWJ}y`, `mi${ZWNJ}shavad`]) {
      expect(new Refusal(`branch ${legit}`, 'x').message).toBe(`branch ${legit}`)
    }
  })
})
