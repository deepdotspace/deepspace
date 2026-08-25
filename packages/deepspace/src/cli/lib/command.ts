/**
 * The shared command-output boundary. Command bodies return content or throw
 * a {@link Refusal}; this runtime owns JSON envelopes, human slugs and optional
 * actions, plus the 0/1/2 exit convention.
 */

import { defineCommand, parseArgs, type ArgsDef, type CommandDef } from 'citty'
import * as p from '@clack/prompts'
import { stopActiveSpinner } from './spinner'
import { executableAction, printAction, withSlug, type CliAction } from './output'
import {
  Refusal,
  errorCode,
  failureEnvelope,
  failureExitCode,
  formatCliError,
  withoutReservedKeys,
} from './cli-errors'

export { cliAction } from './output'
// The refusal class lives with the error renderer (lib/cli-errors) so a plain
// citty command's escaped Refusal renders identically; re-exported here because
// every command imports it from the runtime.
export { Refusal }

/** What a command body returns: the machine payload plus its follow-ups. */
export interface CommandResult {
  /** Merged into the `--json` envelope. Omit for commands with no payload. */
  data?: Record<string, unknown>
  /** One executable follow-up: the `Next:` line and envelope's `action`. */
  action?: CliAction
}

/**
 * Record the exit code and hand control back, letting Node exit naturally once
 * the event loop drains. Never process.exit(): on Windows, exiting after a
 * successful built-in fetch() trips libuv's
 * `!(handle->flags & UV_HANDLE_CLOSING)` assertion (src/win/async.c) and
 * aborts the process (0xC0000409) AFTER the result was printed. Natural exit
 * still guarantees stdout lands whole: `console.log` on a PIPE is asynchronous
 * past the OS buffer (64 KiB on Linux/macOS), but a queued stdout write is an
 * active libuv handle, so Node drains it before the loop empties — no
 * flush-then-exit dance needed for large `--json` payloads.
 */
function finishCommand(code: number): void {
  // A live spinner's repaint interval would keep the naturally-exiting
  // process alive forever; stop it (idempotent) before handing the loop back.
  stopActiveSpinner()
  process.exitCode = code
}

export interface DeepspaceCommandDef<A extends ArgsDef> {
  meta: { name: string; description: string }
  args?: A
  /** Override when a command streams child output before its final envelope. */
  jsonDescription?: string
  /** Print human output yourself; return the machine payload. Throw a
   *  {@link Refusal} for an actionable failure. */
  run: (ctx: { args: Record<string, unknown> & { json: boolean } }) => Promise<CommandResult | void>
}

/** Both spellings citty's parser can produce for one declared name. */
function nameVariants(name: string): string[] {
  return [
    name,
    name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
    name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
  ]
}

/**
 * Option names the command never declared.
 *
 * citty 0.2.2 hardcodes its parser to `strict: false` and exposes no way to
 * change it, so an unknown flag is not rejected — it is silently dropped into
 * the parsed object. `--limitt 1` therefore swallowed both the flag and its
 * value and returned every release, exit 0; `--jsonn` printed human prose to
 * stdout while the caller waited for JSON. Unknown SUBCOMMANDS and bad flag
 * VALUES are both already rejected — only flag names went unchecked.
 *
 * Reading the leftovers back out is what makes one central check possible: no
 * per-command tables, no second parser. Pure + exported for tests.
 */
export function unknownOptionNames(parsed: Record<string, unknown>, args: ArgsDef): string[] {
  const known = new Set<string>(['_'])
  for (const [name, def] of Object.entries(args)) {
    for (const variant of nameVariants(name)) known.add(variant)
    const alias = (def as { alias?: string | string[] }).alias
    for (const a of Array.isArray(alias) ? alias : alias ? [alias] : []) {
      for (const variant of nameVariants(a)) known.add(variant)
    }
  }
  return Object.keys(parsed).filter((key) => !known.has(key))
}

/** Parse only option names, without letting required positionals or enum
 * validation hide an unknown option before the executable-wide preflight can
 * report it. */
export function unknownOptionNamesFromRaw(rawArgs: string[], args: ArgsDef): string[] {
  const relaxedArgs = Object.fromEntries(
    Object.entries(args).map(([name, definition]) => [
      name,
      definition.type === 'enum'
        ? { ...definition, type: 'string' as const, required: false, options: undefined }
        : { ...definition, required: false },
    ]),
  ) as ArgsDef
  return unknownOptionNames(parseArgs(rawArgs, relaxedArgs), args)
}

export function unknownOptionMessage(
  commandName: string,
  unknown: string[],
  args: ArgsDef,
): string {
  const valid = Object.entries(args)
    .filter(([, definition]) => definition.type !== 'positional')
    .map(([name]) => name)
    .sort()
    .join(', ')
  return (
    `Unknown ${unknown.length === 1 ? 'option' : 'options'}: ` +
    `${unknown.map((name) => `--${name}`).join(', ')}. ` +
    `\`${commandName}\` accepts: ${valid || '(none)'}.`
  )
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
  const declaredArgs: ArgsDef = {
    ...(def.args ?? ({} as A)),
    json: {
      type: 'boolean',
      description: def.jsonDescription ?? 'Emit a single-line JSON result for scripts/agents',
      default: false,
    },
  }
  return defineCommand({
    meta: def.meta,
    args: declaredArgs,
    async run({ args }) {
      const json = Boolean((args as { json?: boolean }).json)
      let succeeded = false
      try {
        // Before any side effect: a typo'd flag must not run the command with
        // the caller's intent silently dropped.
        const unknown = unknownOptionNames(args as Record<string, unknown>, declaredArgs)
        if (unknown.length > 0) {
          throw new Refusal(
            unknownOptionMessage(def.meta.name, unknown, declaredArgs),
            'unknown_option',
          )
        }
        // Hoisting `args` to a named ArgsDef (so the unknown-option check can
        // read the same declaration citty parsed against) widens what citty
        // infers here, so the erasure needs the explicit unknown hop.
        const out =
          (await def.run({
            args: args as unknown as Record<string, unknown> & { json: boolean },
          })) ?? {}
        // Success-path actions honor the same contract refusal actions do:
        // executable exactly as given, in the stated cwd — which means the
        // interpreter must be pinned (a linked worktree has no `deepspace`
        // on PATH and no node_modules of its own).
        if (out.action) out.action = executableAction(out.action)
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
        const code = errorCode(err)
        if (json) {
          console.log(JSON.stringify(failureEnvelope(err)))
        } else {
          const message = formatCliError(err)
          const line = code ? withSlug(message, code) : message
          if (refusal?.actionRequired) p.log.warn(line)
          else p.log.error(line)
          if (refusal?.action) printAction(refusal.action)
        }
        finishCommand(failureExitCode(err))
      }
      // `succeeded` gates the fall-through from the catch above: a failure
      // has already recorded its 1/2 exit code and must not be overwritten
      // with 0.
      if (succeeded) finishCommand(0)
    },
  }) as CommandDef
}
