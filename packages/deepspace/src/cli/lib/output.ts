/**
 * The output contract (docs: agent-experience standard).
 *
 * Agents read text: the human output is the interface and must be complete.
 * These helpers standardize its two optional machine anchors —
 *
 *   1. a refusal's final line carries its slug:  `…message. [non_fast_forward]`
 *   2. when a command owns one safe follow-up, its final line names it:
 *      `Next: deepspace pull`
 *
 * `--json` mirrors them (`code`, `action: { cwd, argv }`) but is never the primary
 * surface. Exit codes stay load-bearing: 0 done, 1 failed, 2 succeeded with
 * a local step remaining.
 */

import * as p from '@clack/prompts'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { shQuote } from './cli-format'

/** One executable recovery step. Commands decide which action is appropriate;
 *  the runtime only transports and renders it. */
export interface CliAction {
  cwd: string
  argv: string[]
}

/**
 * An action naming `deepspace` is only runnable where a `deepspace` binary is
 * on PATH — which a linked worktree (a checkout with no `node_modules` of its
 * own), a bare clone directory, or any agent that invokes us through
 * `npx deepspace` is not. When we can identify the CLI entry we are running
 * from, pin it together with its interpreter — the same reasoning as the git
 * credential helper in vc-remote.ts, though that one deliberately pins the
 * RAW argv[1] (its literal path feeds the transient-entry heuristic) while
 * actions resolve symlinks and verify package ownership. Anywhere the entry
 * is unidentifiable (embedded, tests), the plain name is left alone.
 */
export function resolveActionArgv(argv: string[]): string[] {
  if (argv[0] !== 'deepspace') return argv
  const entry = cliEntryPath()
  return entry ? [process.execPath, entry, ...argv.slice(1)] : argv
}

/**
 * The real path of the CLI entry we are executing, or null when it cannot be
 * identified (embedded use, tests, a Windows `.cmd` shim as argv[1] — all
 * fall back to the bare name, which is the pre-pinning behavior, not an
 * error). `npx deepspace` and `node_modules/.bin` on POSIX hand us a symlink
 * to the package's `dist/cli.js` — resolve it, or a pinned action would name
 * a link that only exists in one checkout.
 */
function cliEntryPath(): string | null {
  const entry = process.argv[1]
  if (!entry || !isAbsolute(entry)) return null
  let real: string
  try {
    real = realpathSync(entry)
  } catch {
    return null
  }
  if (!/(^|[\\/])cli\.[cm]?js$/.test(real)) return null
  // `cli.js` is a common entry basename — pin only when it is OUR package's,
  // or an embedding host would be handed deepspace's arguments.
  try {
    const pkg = JSON.parse(readFileSync(resolve(dirname(real), '..', 'package.json'), 'utf-8')) as {
      name?: string
    }
    return pkg.name === 'deepspace' ? real : null
  } catch {
    return null
  }
}

/** The single door every emitted action goes through: pinned, then validated.
 *  Idempotent — a pinned argv starts with the interpreter, not `deepspace`,
 *  so re-applying it is a no-op. */
export function executableAction(action: CliAction): CliAction {
  const pinned = { ...action, argv: resolveActionArgv(action.argv) }
  assertExecutableAction(pinned)
  return pinned
}

/** Construct an action without turning argv back into a shell program. */
export function cliAction(...argv: string[]): CliAction {
  return executableAction({ cwd: process.cwd(), argv })
}

/** Reject action-shaped hints that an agent cannot execute verbatim. */
export function assertExecutableAction(action: CliAction): void {
  if (!isAbsolute(action.cwd)) throw new TypeError('CLI action cwd must be absolute')
  if (action.argv.length === 0 || action.argv[0].trim() === '') {
    throw new TypeError('CLI action argv must name an executable')
  }
  if (action.argv.some((arg) => /^<[^<>]+>$/.test(arg))) {
    throw new TypeError('CLI action argv must not contain placeholder tokens')
  }
}

/** Suffix a refusal message with its machine slug, last line only. Idempotent
 *  (a message already carrying `[slug]` at the end is left alone) so wrapper
 *  layers can apply it without double-tagging. */
export function withSlug(msg: string, code: string): string {
  const tag = `[${code}]`
  return msg.trimEnd().endsWith(tag) ? msg : `${msg.trimEnd()} ${tag}`
}

function displayArg(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg
  // cmd.exe and PowerShell treat single quotes as literal characters, so the
  // POSIX quoting would render Windows paths un-pasteable; double quotes work
  // in both shells.
  if (process.platform === 'win32') return `"${arg.replaceAll('"', '""')}"`
  return shQuote(arg)
}

/** Render the same structured action exposed to agents as a copy-pasteable
 *  human command. The shell string is presentation only, never machine data. */
export function printAction(action: CliAction): void {
  assertExecutableAction(action)
  // Rule 2: this line renders the SAME value `argv` carries. A pinned
  // self-invocation therefore prints as the interpreter + entry it will
  // actually run — `npx deepspace …` would read nicer but is a different
  // command (a registry lookup that can resolve another version).
  const command = action.argv.map(displayArg).join(' ')
  const prefix = action.cwd === process.cwd() ? '' : `cd ${displayArg(action.cwd)} && `
  p.log.message(`Next: ${prefix}${command}`)
}
