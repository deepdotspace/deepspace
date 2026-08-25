// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/g

/** Drop SGR escapes so a machine-read string carries no styling. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/**
 * Styling belongs to terminals. citty freezes its own no-color decision at
 * module load and only honors `NO_COLOR=1` — it never consults stdout — so
 * everything it renders must pass through here before it is printed.
 */
export function forTerminal(s: string): string {
  return process.stdout.isTTY ? s : stripAnsi(s)
}

/** POSIX single-quote a string for safe interpolation into a human-facing
 *  "run this" command. Never use the result as a machine contract — that's
 *  what structured {cwd, argv} is for. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** Render argv as a copy-pasteable human command. */
export function humanCommand(argv: readonly string[]): string {
  return argv.map((arg) => (/^[A-Za-z0-9_./=:@-]+$/.test(arg) ? arg : shQuote(arg))).join(' ')
}

/**
 * Render peer-written text (a workspace task, a branch name, a commit subject)
 * safely into ONE terminal line. Raw, an `ESC[2K\r` erases the row and
 * reprints attacker-chosen text; U+202E and friends reorder a line VISUALLY
 * with no byte changed ("trojan source"). Escaped, not stripped — the text
 * stays readable.
 */
export function displayText(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, (ch) => {
        if (ch === '\t') return '    '
        const code = ch.codePointAt(0)!
        return `\\x${code.toString(16).padStart(2, '0')}`
      })
      // Every format character (Unicode category Cf) EXCEPT the two joiners,
      // plus the LINE and PARAGRAPH separators. An explicit list kept missing
      // Cf members — U+061C, U+2060, the whole astral U+E0000 tag block — so
      // \p{Cf} is used as the closed set the standard maintains. U+2028/U+2029
      // are Zl/Zp rather than Cf and break a line in a terminal, and
      // `displayLines` splits on `\n` alone, so without them a single field
      // could still forge a second row.
      .replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => {
        // ZWJ and ZWNJ are ORTHOGRAPHY, not attack surface: they carry no
        // reordering or hiding power, and escaping them mangles every emoji
        // sequence (👨‍💻), Persian (می‌شود) and Indic (क्‍ष) string that uses
        // them. The characters this defends against are the bidi overrides
        // and isolates, which reorder a line with no byte changed.
        if (ch === '\u200c' || ch === '\u200d') return ch
        const code = ch.codePointAt(0)!
        return `\\u{${code.toString(16)}}`
      })
  )
}

/**
 * The same rule for a COMPOSED message. `displayText` escapes newlines, which
 * is right for a field that must stay one line and wrong for a refusal whose
 * newlines are ours. Both are idempotent, which is what lets this sit at the
 * one exit every human line and every `--json` `error` passes through.
 */
export function displayLines(value: string): string {
  return value
    .split('\n')
    .map((line) => displayText(line))
    .join('\n')
}
