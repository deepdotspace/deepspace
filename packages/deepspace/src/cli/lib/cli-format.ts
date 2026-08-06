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
