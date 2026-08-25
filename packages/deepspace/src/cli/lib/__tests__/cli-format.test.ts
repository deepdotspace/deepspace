/**
 * shQuote: the POSIX single-quote helper applied to human-facing "run this"
 * command renderings. Single quotes neutralize EVERY shell
 * metacharacter, so a branch name or path a collaborator controls can't
 * shell-expand or re-parse when an agent copy-pastes the advice. The result is
 * for humans only — machine recovery uses structured {cwd, argv}.
 */

import { describe, expect, it } from 'vitest'
import { displayLines, displayText, forTerminal, humanCommand, shQuote, stripAnsi } from '../cli-format'

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

describe('displayText — peer-authored strings reach a terminal', () => {
  it('neutralises the escape that erases a row and reprints it', () => {
    // A workspace task or commit subject is written by ONE seat and printed by
    // another. `ESC[2K` + CR clears the line and returns the cursor, so a peer
    // could forge output that reads like the CLI's own.
    const attack = `ok\u001b[2K\rFAKE: everything is fine`
    const shown = displayText(attack)
    expect(shown).not.toContain('\u001b')
    expect(shown).not.toContain('\r')
    expect(shown).toContain('\\x1b')
    // The readable text survives — this is escaping, not stripping.
    expect(shown).toContain('FAKE: everything is fine')
  })

  it('leaves ordinary text, unicode and emoji untouched', () => {
    expect(displayText('日本語 branch 😀 — fine')).toBe('日本語 branch 😀 — fine')
  })

  it('expands a tab rather than escaping it', () => {
    // Tabs are legitimate spacing, not a control sequence worth escaping.
    expect(displayText('a\tb')).toBe('a    b')
  })
})

describe('displayText neuters what reorders a line, not just what erases it', () => {
  it('escapes bidi overrides and isolates', () => {
    // U+202E reorders the REST of the line visually with no byte changed.
    const shown = displayText('fix-\u202egnp.txt')
    expect(shown).not.toContain('\u202e')
    expect(shown).toContain('\\u{202e}')
    for (const ch of ['\u202a', '\u202b', '\u202c', '\u202d', '\u2066', '\u2067', '\u2068', '\u2069']) {
      expect(displayText(`a${ch}b`), ch).not.toContain(ch)
    }
  })

  it('escapes the format characters an explicit list kept missing', () => {
    // Each of these rode through the hand-written class: the Arabic letter
    // mark, the word joiner (hides inside an identifier), the soft hyphen,
    // and the ASTRAL tag block — 29 codepoints of invisible payload that a
    // non-unicode regex cannot even see.
    for (const ch of ['\u061c', '\u2060', '\u00ad', '\ufeff', '\u{e0041}', '\u{e007f}']) {
      const shown = displayText(`ws_${ch}01ABC`)
      expect(shown, ch).not.toContain(ch)
      expect(shown, ch).toContain('\\u{')
    }
  })

  it('leaves the JOINERS alone — they are orthography, not attack surface', () => {
    // ZWJ/ZWNJ cannot reorder or hide anything, and escaping them mangles
    // every emoji sequence and every Persian/Indic word that needs them.
    for (const text of ['fix \u{1f468}\u200d\u{1f4bb} build', '\u{1f3f3}\ufe0f\u200d\u{1f308}', 'می\u200cشود', 'क्\u200dष']) {
      expect(displayText(text), text).toBe(text)
    }
  })

  it('still passes ordinary text through untouched', () => {
    for (const text of ['plain title', 'emoji ok', '日本語のタイトル', 'a-b_c.d/e']) {
      expect(displayText(text), text).toBe(text)
    }
  })
})

describe('displayLines — the same rule for a COMPOSED message', () => {
  const ESC = String.fromCodePoint(0x1b)
  const NL = String.fromCodePoint(0x0a)
  const CR = String.fromCodePoint(0x0d)

  it('keeps OUR newlines where displayText escapes them', () => {
    // A refusal is built from several sentences; those newlines are the
    // CLI's, not a peer's, and a chokepoint that mangled them could not sit
    // at the exit every message passes through.
    const composed = ['Refusing to push.', 'Pull first.'].join(NL)
    expect(displayLines(composed)).toBe(composed)
    expect(displayText(composed)).not.toContain(NL)
  })

  it('still neutralises a row-erasing sequence embedded in a message', () => {
    const shown = displayLines(`Pushed ${ESC}[2K${CR}FAKE: everything is fine`)
    expect(shown).not.toContain(ESC)
    expect(shown).not.toContain(CR)
    expect(shown).toContain('FAKE: everything is fine')
  })

  it('is idempotent — a field escaped at its own call site survives the exit pass', () => {
    const once = displayLines(`branch ${ESC}[31mred${NL}second`)
    expect(displayLines(once)).toBe(once)
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

describe('the line and paragraph separators are escaped too', () => {
  const LS = String.fromCodePoint(0x2028)
  const PS = String.fromCodePoint(0x2029)

  it('escapes U+2028/U+2029, which are Zl/Zp rather than Cf', () => {
    // A terminal breaks a line on these, and `displayLines` splits on `\n`
    // alone — so a single field carrying one could still forge a second row.
    for (const ch of [LS, PS]) {
      const shown = displayText(`ws ${ch}FAKE: done`)
      expect(shown).not.toContain(ch)
      expect(shown).toContain('\\u{202')
      expect(shown).toContain('FAKE: done')
    }
  })

  it('escapes them through the composed-message form as well', () => {
    const shown = displayLines(`Refusing to push.${LS}FAKE: pushed.`)
    expect(shown).not.toContain(LS)
    expect(shown.split('\n')).toHaveLength(1)
  })
})
