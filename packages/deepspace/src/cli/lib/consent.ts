/**
 * THE destructive-consent gate — one implementation of the pattern five
 * commands were each hand-rolling (undeploy, secrets configs delete, domain
 * buy/detach, test accounts recover --all):
 *
 *   - `--yes` is consent; return.
 *   - `--json` or a non-TTY stdin: a prompt would hang a machine caller
 *     forever, so refuse `confirmation_required` naming the flag — the
 *     command itself is never consent (the 0.25.0 AX rule).
 *   - Interactive: one clack confirm, defaulting to NO (Enter must never be
 *     the destructive answer — the rename prompt learned this in r2).
 *
 * Each hand-rolled copy was a chance to re-make a solved mistake: undeploy's
 * gate ran before its ownership check until v0.27.0, recover --all had no
 * TTY prompt at all, and domain carried its own raw-stdin prompt with its
 * own flowing-mode-unref lore. The MESSAGE stays the caller's — it must name
 * exactly what is destroyed and what survives — only the mechanics live
 * here. Deliberately NOT used by `transfer offer --replace` (a different
 * flag with narrower meaning) or `integrations invoke` (billed calls take
 * `--yes` unconditionally, no prompt): forcing those in would trade their
 * precision for uniformity.
 */

import * as p from '@clack/prompts'
import { Refusal } from './cli-errors'

export async function requireConsent(opts: {
  /** The parsed `--yes` value. */
  yes: boolean
  /** The parsed `--json` value. */
  json: boolean
  /** What is about to happen — names what is destroyed and what survives.
   *  Used for the refusal; also the prompt unless `prompt` is given. */
  message: string
  /** Interactive phrasing, when it should differ from the refusal sentence.
   *  A function is evaluated ONLY when the gate is about to ask — so work
   *  that exists purely to feed the question (e.g. counting what a delete
   *  takes with it) runs after the machine-caller refusal, never before it,
   *  and never at all under `--yes`. */
  prompt?: string | (() => Promise<string>)
  /** Refusal code; the contract's default fits almost every gate. */
  code?: string
  /** Thrown when the interactive answer is No. */
  declineMessage?: string
  declineCode?: string
  extra?: Record<string, unknown>
}): Promise<void> {
  if (opts.yes) return
  if (opts.json || !process.stdin.isTTY) {
    throw new Refusal(
      `${opts.message} Re-run with --yes to confirm.`,
      opts.code ?? 'confirmation_required',
      { extra: opts.extra },
    )
  }
  const confirmed = await p.confirm({
    message:
      typeof opts.prompt === 'function' ? await opts.prompt() : (opts.prompt ?? opts.message),
    initialValue: false,
  })
  if (p.isCancel(confirmed) || !confirmed) {
    throw new Refusal(opts.declineMessage ?? 'Cancelled.', opts.declineCode ?? 'consent_declined', {
      extra: opts.extra,
    })
  }
}
