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

/**
 * API error slugs that genuinely confuse people → what to tell them. Slugs
 * whose meaning is obvious from the name (invalid_email, ...) stay unmapped
 * and render as-is; don't grow this into a mirror of the server's errors.
 */
const API_ERROR_HINTS: Record<string, string> = {
  not_app_owner: 'Only the app owner can do this.',
  app_not_found:
    'App not found. Check the app id — the DEEPSPACE_APP_ID value in wrangler.toml, usually ' +
    '`app_…` (a legacy app\'s id is its name). List your apps with `deepspace apps`. ' +
    '(`domain` commands take the deployed app *name* instead.)',
  not_app_owner_or_collaborator: 'You must be the app owner or a collaborator to do this.',
  test_account_cannot_be_collaborator:
    'Test accounts cannot be added as collaborators. Use a real DeepSpace account.',
  user_not_found:
    'No DeepSpace user with that email. They need to log in to DeepSpace at least once ' +
    '(`deepspace login`, or sign in to any app) before they can be referenced by email.',
  insufficient_credits:
    'Out of credits. Inviting a new collaborator by email sends them a transactional ' +
    'email billed to your account — top up your credits and try again.',
  invite_email_failed:
    'The invite email could not be sent. You were not charged — please try again in a moment.',
}

/** Exported for tests. One clean message for an escaped error. */
export function formatCliError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // Preferred: the platform returns { error: <sentence>, code: <slug> } and
  // apiFetch throws a typed ApiError carrying the code. Fallback: legacy
  // helpers throw `API <path> (<status>): <slug>` with the slug in the text.
  const code = (err as { code?: unknown })?.code
  const slug =
    typeof code === 'string' ? code : /^API \S+ \(\d+\): ([a-z0-9_]+)$/.exec(message)?.[1]
  const hint = slug ? API_ERROR_HINTS[slug] : undefined
  // The server sentence and the hint can say the same thing — don't stutter.
  return hint && !message.includes(hint) ? `${message}\n${hint}` : message
}

function renderCliError(err: unknown): never {
  console.error(formatCliError(err))
  if (process.env.DEBUG) {
    // ApiError/secretsApi keep the internal REST path off the message; show it here.
    const { apiPath, status } = err as { apiPath?: string; status?: number }
    if (apiPath) console.error(`\nAPI ${apiPath}${status ? ` (${status})` : ''}`)
    if (err instanceof Error && err.stack) console.error('\n' + err.stack)
  }
  process.exit(1)
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
