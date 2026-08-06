/**
 * The shared command-output boundary. Command bodies return content or throw
 * a {@link Refusal}; this runtime owns JSON envelopes, human slugs and optional
 * actions, plus the 0/1/2 exit convention.
 */

import { defineCommand, type ArgsDef, type CommandDef } from 'citty'
import * as p from '@clack/prompts'
import { stopActiveSpinner } from './spinner'
import { assertExecutableAction, printAction, withSlug, type CliAction } from './output'
import { errorCode } from './cli-errors'
import { ApiError } from './api'

export { cliAction } from './output'

/**
 * A refusal the caller can act on: carries the machine slug that appears both
 * in `--json` as `code` and at the end of the human line, plus at most one
 * executable action that resolves it.
 *
 * `actionRequired` marks the third exit state — the operation did what it
 * could and a LOCAL step remains (merge the tip, commit the tree). It exits 2,
 * which is the difference between "this failed" and "your turn", and is the
 * single most useful signal an agent gets from this CLI.
 */
export class Refusal extends Error {
  readonly code: string
  readonly action: CliAction | undefined
  readonly actionRequired: boolean
  readonly extra: Record<string, unknown>

  constructor(
    message: string,
    code: string,
    opts: { action?: CliAction; actionRequired?: boolean; extra?: Record<string, unknown> } = {},
  ) {
    super(message)
    this.name = 'Refusal'
    this.code = code
    if (opts.action) assertExecutableAction(opts.action)
    this.action = opts.action
    this.actionRequired = opts.actionRequired ?? false
    this.extra = opts.extra ?? {}
  }
}

/** What a command body returns: the machine payload plus its follow-ups. */
export interface CommandResult {
  /** Merged into the `--json` envelope. Omit for commands with no payload. */
  data?: Record<string, unknown>
  /** One executable follow-up: the `Next:` line and envelope's `action`. */
  action?: CliAction
}

/**
 * Structured fields a server refusal carried, for commands that surface an
 * {@link ApiError} directly rather than translating it into a {@link Refusal}.
 * Without this the envelope kept only the sentence, so an agent had to read
 * numbers like remaining storage back out of prose the API had already
 * quantified.
 */
function apiErrorDetails(err: unknown): Record<string, unknown> | undefined {
  return err instanceof ApiError ? err.details : undefined
}

/**
 * Strip the envelope's reserved keys from a payload before it is spread into
 * the envelope. `data`/`extra` can carry raw server JSON (`integrations
 * invoke` forwards the response body verbatim), and a payload containing
 * `ok`, `action`, or `actionRequired` must not be able to flip a failure to
 * success or hand an agent an unvalidated recovery action.
 */
function withoutReservedKeys(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(
      ([key]) =>
        ![
          'ok',
          'code',
          'error',
          'action',
          'actionRequired',
          'next',
          'nextAction',
          'resume',
        ].includes(key),
    ),
  )
}

/**
 * Exit only once stdout has drained. `console.log` on a PIPE is asynchronous
 * past the OS buffer (64 KiB on Linux/macOS), so exiting immediately truncates
 * a large payload mid-write — `integrations list --json` is already ~29 KB and
 * the catalog grows. The empty write's callback fires after the queue flushes.
 */
function exitWhenFlushed(code: number): never {
  // Nothing queued (a TTY, a small payload, or a test harness capturing
  // console.log) — exit synchronously. Deferring unconditionally would break
  // any caller that mocks process.exit and asserts synchronously, and would
  // let execution continue past a `never` return.
  if (process.stdout.writableLength === 0) process.exit(code)
  process.stdout.write('', () => process.exit(code))
  return undefined as never
}

export interface DeepspaceCommandDef<A extends ArgsDef> {
  meta: { name: string; description: string }
  args?: A
  /** Print human output yourself; return the machine payload. Throw a
   *  {@link Refusal} for an actionable failure. */
  run: (ctx: { args: Record<string, unknown> & { json: boolean } }) => Promise<CommandResult | void>
}

/**
 * Wrap a command body in the contract. Injects `--json`, renders both output
 * paths, and owns the exit codes — a body never calls process.exit itself.
 */
export function defineDeepspaceCommand<A extends ArgsDef>(def: DeepspaceCommandDef<A>): CommandDef {
  // The injected `json` arg widens citty's inferred ArgsDef generic, which no
  // longer matches the bare `CommandDef` the registry holds. The runtime reads
  // args dynamically, so the erasure is safe and keeps every command in the
  // tree one uniform type.
  return defineCommand({
    meta: def.meta,
    args: {
      ...(def.args ?? ({} as A)),
      json: {
        type: 'boolean',
        description: 'Emit a single-line JSON result for scripts/agents',
        default: false,
      },
    },
    async run({ args }) {
      const json = Boolean((args as { json?: boolean }).json)
      let succeeded = false
      try {
        const out =
          (await def.run({ args: args as Record<string, unknown> & { json: boolean } })) ?? {}
        if (out.action) assertExecutableAction(out.action)
        if (json) {
          console.log(
            JSON.stringify({
              ok: true,
              ...withoutReservedKeys(out.data ?? {}),
              ...(out.action ? { action: out.action } : {}),
            }),
          )
        } else if (out.action) {
          printAction(out.action)
        }
        succeeded = true
      } catch (err) {
        stopActiveSpinner()
        const refusal = err instanceof Refusal ? err : null
        const code = refusal?.code ?? errorCode(err)
        const message = err instanceof Error ? err.message : String(err)
        if (json) {
          console.log(
            JSON.stringify({
              ok: false,
              ...(code ? { code } : {}),
              ...(refusal?.actionRequired ? { actionRequired: true } : {}),
              error: message,
              ...(refusal?.action ? { action: refusal.action } : {}),
              ...withoutReservedKeys(refusal?.extra ?? apiErrorDetails(err) ?? {}),
            }),
          )
        } else {
          const line = code ? withSlug(message, code) : message
          if (refusal?.actionRequired) p.log.warn(line)
          else p.log.error(line)
          if (refusal?.action) printAction(refusal.action)
        }
        // 2 = "it worked, but a local step remains"; 1 = it failed.
        exitWhenFlushed(refusal?.actionRequired ? 2 : 1)
      }
      // OUTSIDE the try on purpose: a test that mocks process.exit to throw
      // would otherwise have the success path land in the catch above and be
      // re-rendered as a failure.
      if (succeeded) exitWhenFlushed(0)
    },
  }) as CommandDef
}
