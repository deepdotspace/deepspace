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
