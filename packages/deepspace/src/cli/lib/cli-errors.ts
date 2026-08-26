/**
 * Friendly rendering for errors that escape a command's run().
 *
 * citty's runMain catches escaped errors and console.errors the full Error
 * object — stack trace and all. For expected operational failures (an API
 * 403, a network hiccup) that reads like a crash. wrapCommandErrors()
 * recursively wraps every command's run() so escaped errors render as a
 * single clean message (with known API error slugs translated), while
 * citty's own help/version/usage handling stays untouched. Set DEBUG=1 to
 * get the full stack back.
 */

import type { CommandDef } from 'citty'
import { stopActiveSpinner } from './spinner'
import { executableAction, printAction, withSlug, type CliAction } from './output'
import { displayLines } from './cli-format'
import { ApiError } from './api'

/**
 * A client-side or precondition failure that carries a machine `code`, so a
 * thrown error (a blank `--app`, "not logged in", an empty repo) reads in
 * `--json` exactly like a server ApiError — `{ ok:false, code, error }` — rather
 * than a bare message. Reuses no HTTP semantics (unlike ApiError). Most instances
 * are pure client-side validation that never touch the network; a few are
 * preconditions checked before the real work (e.g. an expired session, detected
 * after a refresh attempt) — the shared contract is only "carries a stable code".
 */
export class InputError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    // Same exit rule as `Refusal` (lib/command.ts): a refusal's text and its
    // `--json` `error` are the same string, so it is escaped once, here.
    super(displayLines(message))
  }
}

/** `uv_cwd` — the process's working directory no longer exists. Node reports
 *  it as a bare ENOENT whose syscall/message names uv_cwd rather than a path. */
export function isMissingCwdError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const errno = err as NodeJS.ErrnoException & { syscall?: string }
  if (errno.code !== 'ENOENT') return false
  // `syscall` alone. Matching the MESSAGE for 'uv_cwd' also matched an
  // ordinary missing FILE whose path happens to contain that string, and
  // reported it as a vanished working directory — the genuine error always
  // carries the syscall, so the substring bought nothing.
  return errno.syscall === 'uv_cwd'
}

/**
 * A refusal the caller can act on: carries the machine slug that appears both
 * in `--json` as `code` and at the end of the human line, plus at most one
 * executable action that resolves it.
 *
 * `actionRequired` marks the third exit state — the operation did what it
 * could and a LOCAL step remains (merge the tip, commit the tree). It exits 2,
 * which is the difference between "this failed" and "your turn", and is the
 * single most useful signal an agent gets from this CLI.
 *
 * Lives here (not in the command runtime) so that {@link errorCode} and
 * {@link renderCliError} — the path a plain citty command's escaped error
 * takes — read it exactly like the runtime does. Before, a Refusal thrown by a
 * shared helper (`ensureToken`, the app-target resolver) lost its code and its
 * action the moment it crossed into a command that renders through here.
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
    // The exit every refusal passes through, human and `--json` alike —
    // `Refusal.message` IS the envelope's `error`. Escaping it here rather than
    // at each call site is the whole point: three rounds of sink-by-sink fixes
    // closed a branch-list echo while leaving the `--into` argument raw in the
    // same sentence, and left `push`, `pull` and `status` untouched.
    super(displayLines(message))
    this.name = 'Refusal'
    this.code = code
    // Actions built as object literals get the same executable-argv treatment
    // `cliAction` applies, so no refusal can hand out a bare `deepspace` that
    // its own `cwd` cannot run.
    this.action = opts.action ? executableAction(opts.action) : undefined
    this.actionRequired = opts.actionRequired ?? false
    this.extra = opts.extra ?? {}
  }
}

/**
 * Strip the envelope's reserved keys from a payload before it is spread into
 * the envelope. `data`/`extra` can carry raw server JSON (`integrations
 * invoke` forwards the response body verbatim), and a payload containing
 * `ok`, `action`, or `actionRequired` must not be able to flip a failure to
 * success or hand an agent an unvalidated recovery action.
 */
export function withoutReservedKeys(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(
      ([key]) =>
        !['ok', 'code', 'error', 'action', 'actionRequired', 'next', 'nextAction', 'resume'].includes(
          key,
        ),
    ),
  )
}

/**
 * The one `--json` failure envelope: `{ ok:false, code?, actionRequired?, error,
 * action?, …details }`. Details are a Refusal's `extra`, else the structured
 * fields a server refusal carried (an {@link ApiError}'s `details`) — without
 * them the envelope kept only the sentence, and an agent had to read numbers
 * like remaining storage back out of prose the API had already quantified.
 */
export function failureEnvelope(err: unknown): Record<string, unknown> {
  const refusal = err instanceof Refusal ? err : null
  const code = errorCode(err)
  const details = refusal?.extra ?? (err instanceof ApiError ? err.details : undefined) ?? {}
  return {
    ok: false,
    ...(code ? { code } : {}),
    ...(refusal?.actionRequired ? { actionRequired: true } : {}),
    error: formatCliError(err),
    ...(refusal?.action ? { action: refusal.action } : {}),
    ...withoutReservedKeys(details),
  }
}

/** 2 = "it worked, but a local step remains"; 1 = it failed. */
export function failureExitCode(err: unknown): 1 | 2 {
  return err instanceof Refusal && err.actionRequired ? 2 : 1
}

/**
 * Thrown by an output owner (deploy's `die()`/`bail()`) AFTER it has fully
 * rendered a failure, purely to end control flow; it carries only the exit
 * code. {@link renderCliError} recognizes it and records the code without a
 * second rendering. A thrown sentinel rather than process.exit() because on
 * Windows exiting after a completed built-in fetch() aborts the process —
 * see lib/command.ts.
 */
export class CliExit extends Error {
  constructor(readonly exitCode: number) {
    super(`exit ${exitCode}`)
    this.name = 'CliExit'
  }
}

/**
 * The machine `code` slug an error carries, if any — an {@link ApiError} (server
 * failure) or an {@link InputError} (client-side validation). Lets a command's
 * `--json` catch surface `code` uniformly without knowing the concrete type.
 * Deliberately narrow: it does NOT read arbitrary `.code` properties (a Node
 * `ENOENT` fs error must not leak into the machine contract as a `code`).
 */
export function errorCode(err: unknown): string | undefined {
  if (err instanceof ApiError || err instanceof InputError || err instanceof Refusal) return err.code
  // The ONE Node errno that is not an internal detail: the process's own
  // working directory is gone, which is what a deleted worktree looks like
  // from inside it (`uv_cwd`). It throws at the first `process.cwd()` a
  // command reaches — usually its opening line — so without this the whole
  // CLI answers an uncoded `ENOENT: … uv_cwd` from every verb, and the
  // `worktree_missing` diagnosis one layer down is unreachable exactly when
  // it is needed.
  if (isMissingCwdError(err)) return 'worktree_missing'
  // GitError (raw git operation/transport failure) — duck-typed by `name` to
  // avoid a cli-errors↔git import cycle. Give it a generic `git_error` (or its
  // own slug, if set) so a --json caller can branch on "a git op failed"
  // instead of scraping the fatal-… prose.
  if (err instanceof Error && err.name === 'GitError') return (err as { code?: string }).code ?? 'git_error'
  // WranglerConfigError (unreadable / malformed / self-contradictory
  // wrangler.toml) — duck-typed for the same reason: it lives in the one
  // wrangler.toml reader, which `deepspace/build` imports and which therefore
  // must not pull this module's CLI stack into an app's build graph.
  if (err instanceof Error && err.name === 'WranglerConfigError')
    return (err as { code?: string }).code ?? 'invalid_config'
  return undefined
}

/**
 * API error slugs that genuinely confuse people → what to tell them. Slugs
 * whose meaning is obvious from the name (invalid_email, ...) stay unmapped
 * and render as-is; don't grow this into a mirror of the server's errors.
 */
const API_ERROR_HINTS: Record<string, string> = {
  // Starts where the server sentence ("Only the app owner can do this.")
  // stops, so the two read as one message instead of a stutter.
  not_app_owner:
    'Collaborators can deploy and manage secrets, but ownership verbs (collaborators, transfer, ' +
    'undeploy) stay with the owner. Ask them to run it, have them transfer the app ' +
    '(`deepspace app transfer offer`), or fork your checkout as your own app ' +
    '(`deepspace app init --new-id`).',
  app_not_found:
    'App not found on the service this command asked. Check the app id — the DEEPSPACE_APP_ID ' +
    'value in wrangler.toml, usually `app_…` (a legacy app\'s id is its name); list your apps ' +
    'with `deepspace app list`. If you are overriding DEEPSPACE_DEPLOY_URL (staging), note that ' +
    'account/collaborator commands go to the PLATFORM API — an app registered only on a staging ' +
    'deploy service is unknown there. (`domain` commands take the deployed app *name* instead.)',
  not_app_owner_or_collaborator: 'You must be the app owner or a collaborator to do this.',
  test_account_cannot_be_collaborator:
    'Test accounts cannot be added as collaborators. Use a real DeepSpace account.',
  user_not_found:
    'No DeepSpace user with that email. They need to log in to DeepSpace at least once ' +
    '(`deepspace auth login`, or sign in to any app) before they can be referenced by email.',
  insufficient_credits:
    'Out of credits. Inviting a new collaborator by email sends them a transactional ' +
    'email billed to your account — top up your credits and try again.',
  // "Try again" alone sends callers into a loop when the address itself is the
  // problem — the send is what failed, and an undeliverable address fails the
  // same way every time.
  invite_email_failed:
    'The invite itself was not created and the charge was voided — nothing to undo. Retrying ' +
    'helps only if the send was transient; check the address is real and deliverable first. ' +
    'An email is needed ONLY for someone with no DeepSpace account yet: an existing user is ' +
    'added instantly, so having them sign in once and re-running this skips email entirely. ' +
    'If a retry now reports `already_invited` with no email sent, cancel the stuck invite ' +
    '(`deepspace app collaborators cancel <email>`) and invite again.',
}

/** Exported for tests. One clean message for an escaped error. */
export function formatCliError(err: unknown): string {
  // `ENOENT: no such file or directory, uv_cwd` names neither the directory
  // nor the fix. This is the message every command produces when the shell is
  // sitting in a worktree that was landed, dropped, or merged away.
  if (isMissingCwdError(err)) {
    // The path is NOT knowable from the error (process.cwd() is what failed),
    // but the shell exports PWD, so name it when it is there. And do not
    // assert a cause: every verb answers this, including ones with nothing to
    // do with version control, and "it was most likely a workspace worktree"
    // is a guess dressed as a finding.
    const pwd = process.env.PWD
    return (
      `The directory this command was run from no longer exists${pwd ? ` (${pwd})` : ''} — ` +
      'it was deleted or moved while the shell was still in it. Move somewhere that exists ' +
      '(`cd` to the main checkout). If it was a workspace worktree that a land, merge, or drop ' +
      'removed, `deepspace workspace attach <ws_…>` re-materializes it there.'
    )
  }
  const message = err instanceof Error ? err.message : String(err)
  // The platform returns { error: <sentence>, code: <slug> }, and apiFetch
  // preserves that code on a typed error. Never infer machine state from prose.
  const slug = errorCode(err)
  const hint = slug ? API_ERROR_HINTS[slug] : undefined
  // The server sentence and the hint can say the same thing — don't stutter.
  return hint && !message.includes(hint) ? `${message}\n${hint}` : message
}

/**
 * Records the exit code via process.exitCode and RETURNS — never
 * process.exit(), which on Windows aborts the process when called after a
 * completed built-in fetch() (see lib/command.ts). Every caller is the last
 * act of its command, so returning lets Node exit naturally.
 */
export function renderCliError(err: unknown): void {
  // A command may throw with its progress spinner still live; stop it FIRST,
  // on every path including CliExit — its repaint interval would keep the
  // naturally-exiting process alive, and its exit-time frame can abort on
  // Windows (see spinner.ts). Idempotent, so an already-stopped spinner is
  // free.
  stopActiveSpinner()
  // A CliExit was already rendered by its thrower (deploy's die()/bail());
  // just record its code — a second rendering would double the output.
  if (err instanceof CliExit) {
    process.exitCode = err.exitCode
    return
  }
  const message = formatCliError(err)
  const slug = errorCode(err)
  // `--json` callers get the envelope every other refusal path emits. Without
  // this, an error that ESCAPES a command's own try/catch printed prose to
  // stderr and left stdout EMPTY — a machine consumer saw a non-zero exit with
  // nothing to parse. Commands that catch their own errors are unaffected;
  // this is the fallback for the ~15 that don't.
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(failureEnvelope(err)))
    process.exitCode = failureExitCode(err)
    return
  }
  // Human path: the last line carries the machine slug, per the output
  // contract (lib/output.ts), and a Refusal's one executable follow-up.
  console.error(slug ? withSlug(message, slug) : message)
  if (err instanceof Refusal && err.action) printAction(err.action)
  if (process.env.DEBUG) {
    // ApiError keeps the internal REST path off the message; show it here.
    const { apiPath, status } = err as { apiPath?: string; status?: number }
    if (apiPath) console.error(`\nAPI ${apiPath}${status ? ` (${status})` : ''}`)
    if (err instanceof Error && err.stack) console.error('\n' + err.stack)
  }
  process.exitCode = failureExitCode(err)
}

type RunFn = NonNullable<CommandDef['run']>

/**
 * Recursively wrap a concrete command tree's run() handlers. Only plain
 * object subcommands are wrapped — every command in this CLI is one; lazy
 * (function/promise) subcommand definitions would pass through unwrapped.
 */
export function wrapCommandErrors<T extends CommandDef>(cmd: T): T {
  const run = cmd.run
  if (run) {
    cmd.run = (async (ctx: Parameters<RunFn>[0]) => {
      try {
        await run(ctx)
      } catch (err) {
        renderCliError(err)
      }
    }) as RunFn
  }
  if (cmd.subCommands && typeof cmd.subCommands === 'object') {
    for (const sub of Object.values(cmd.subCommands)) {
      if (sub && typeof sub === 'object') wrapCommandErrors(sub as CommandDef)
    }
  }
  return cmd
}
