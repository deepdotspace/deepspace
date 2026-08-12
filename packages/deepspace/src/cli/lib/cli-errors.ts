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
import { withSlug } from './output'
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
    super(message)
  }
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
  if (err instanceof ApiError || err instanceof InputError) return err.code
  // GitError (raw git operation/transport failure) — duck-typed by `name` to
  // avoid a cli-errors↔git import cycle. Give it a generic `git_error` (or its
  // own slug, if set) so a --json caller can branch on "a git op failed"
  // instead of scraping the fatal-… prose.
  if (err instanceof Error && err.name === 'GitError') return (err as { code?: string }).code ?? 'git_error'
  return undefined
}

/**
 * API error slugs that genuinely confuse people → what to tell them. Slugs
 * whose meaning is obvious from the name (invalid_email, ...) stay unmapped
 * and render as-is; don't grow this into a mirror of the server's errors.
 */
const API_ERROR_HINTS: Record<string, string> = {
  not_app_owner: 'Only the app owner can do this.',
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
  // A CliExit was already rendered by its thrower (deploy's die()/bail());
  // just record its code — a second rendering would double the output.
  if (err instanceof CliExit) {
    process.exitCode = err.exitCode
    return
  }
  // A command may throw with its progress spinner still live; stop it — its
  // repaint interval would keep the naturally-exiting process alive, and its
  // exit-time frame can abort on Windows (see spinner.ts).
  stopActiveSpinner()
  const message = formatCliError(err)
  const slug = errorCode(err)
  // `--json` callers get the envelope every other refusal path emits. Without
  // this, an error that ESCAPES a command's own try/catch printed prose to
  // stderr and left stdout EMPTY — a machine consumer saw a non-zero exit with
  // nothing to parse. Commands that catch their own errors are unaffected;
  // this is the fallback for the ~15 that don't.
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: false, ...(slug ? { code: slug } : {}), error: message }))
    process.exitCode = 1
    return
  }
  // Human path: the last line carries the machine slug, per the output
  // contract (lib/output.ts).
  console.error(slug ? withSlug(message, slug) : message)
  if (process.env.DEBUG) {
    // ApiError/secretsApi keep the internal REST path off the message; show it here.
    const { apiPath, status } = err as { apiPath?: string; status?: number }
    if (apiPath) console.error(`\nAPI ${apiPath}${status ? ` (${status})` : ''}`)
    if (err instanceof Error && err.stack) console.error('\n' + err.stack)
  }
  process.exitCode = 1
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
