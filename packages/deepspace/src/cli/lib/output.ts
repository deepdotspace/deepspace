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
import { isAbsolute } from 'node:path'
import { shQuote } from './cli-format'

/** One executable recovery step. Commands decide which action is appropriate;
 *  the runtime only transports and renders it. */
export interface CliAction {
  cwd: string
  argv: string[]
}

/** Construct an action without turning argv back into a shell program. */
export function cliAction(...argv: string[]): CliAction {
  const action = { cwd: process.cwd(), argv }
  assertExecutableAction(action)
  return action
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
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(arg) ? arg : shQuote(arg)
}

/** Render the same structured action exposed to agents as a copy-pasteable
 *  human command. The shell string is presentation only, never machine data. */
export function printAction(action: CliAction): void {
  assertExecutableAction(action)
  const command = action.argv.map(displayArg).join(' ')
  const prefix = action.cwd === process.cwd() ? '' : `cd ${displayArg(action.cwd)} && `
  p.log.message(`Next: ${prefix}${command}`)
}
