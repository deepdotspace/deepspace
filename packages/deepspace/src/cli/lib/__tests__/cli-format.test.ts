/**
 * shQuote: the POSIX single-quote helper applied to human-facing "run this"
 * command renderings. Single quotes neutralize EVERY shell
 * metacharacter, so a branch name or path a collaborator controls can't
 * shell-expand or re-parse when an agent copy-pastes the advice. The result is
 * for humans only — machine recovery uses structured {cwd, argv}.
 */

import { describe, expect, it } from 'vitest'
import { forTerminal, humanCommand, shQuote, stripAnsi } from '../cli-format'

describe('shQuote', () => {
  it('wraps an ordinary string in single quotes', () => {
    expect(shQuote('main')).toBe("'main'")
    expect(shQuote('refs/heads/feature')).toBe("'refs/heads/feature'")
  })

  it('preserves spaces as a single quoted argument', () => {
    expect(shQuote('/Users/me/my project')).toBe("'/Users/me/my project'")
  })

  it('neutralizes command-substitution, semicolons, and ampersands', () => {
    expect(shQuote('$(rm -rf ~)')).toBe("'$(rm -rf ~)'")
    expect(shQuote('a;b&c')).toBe("'a;b&c'")
    expect(shQuote('`whoami`')).toBe("'`whoami`'")
  })

  it('escapes an embedded single quote the POSIX way (close-escape-reopen)', () => {
    // o'brien → 'o'\''brien' — three shell tokens that concatenate to o'brien.
    expect(shQuote("o'brien")).toBe("'o'\\''brien'")
    expect(shQuote("'")).toBe("''\\'''")
  })

  it('keeps a newline inside the quotes (still one literal argument)', () => {
    expect(shQuote('line1\nline2')).toBe("'line1\nline2'")
  })
})

describe('humanCommand', () => {
  it('leaves ordinary arguments unquoted', () => {
    expect(humanCommand(['deepspace', 'workspace', 'land', '--validate'])).toBe(
      'deepspace workspace land --validate',
    )
  })

  it('POSIX-quotes shell metacharacters in an argument', () => {
    const rendered = humanCommand(['deepspace', 'workspace', 'land', '--into', 'evil;$(rm -rf /)'])
    expect(rendered).toBe("deepspace workspace land --into 'evil;$(rm -rf /)'")
  })
})

describe('terminal styling', () => {
  const colored = `\u001b[36mdeepspace status\u001b[39m`

  it('strips SGR escapes', () => {
    expect(stripAnsi(colored)).toBe('deepspace status')
    expect(stripAnsi('plain')).toBe('plain')
  })

  /** citty renders help with color unless NO_COLOR is exactly "1", ignoring a
   *  piped stdout — so a piped `--help` used to carry escapes into whatever
   *  parsed it. forTerminal is the one place that decision is made. */
  it('keeps color for a TTY and drops it for a pipe', () => {
    const original = process.stdout.isTTY
    const setTty = (value: boolean | undefined) =>
      Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
    try {
      setTty(true)
      expect(forTerminal(colored)).toBe(colored)
      setTty(false)
      expect(forTerminal(colored)).toBe('deepspace status')
      expect(forTerminal(colored)).not.toContain('\u001b')
    } finally {
      setTty(original)
    }
  })
})
