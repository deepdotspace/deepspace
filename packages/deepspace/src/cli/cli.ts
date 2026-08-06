/**
 * DeepSpace CLI
 *
 * Public hierarchy is defined by the grouped command table below and
 * documented in docs/platform/cli-contract.md. Keep app lifecycle under
 * `app`, sessions under `auth`, local development under `dev`, and testing
 * under `test`.
 */

import { defineCommand, runMain, runCommand, renderUsage } from 'citty'
// cross-spawn, not node:child_process: on Windows `npx` is `npx.cmd`, and since
// Node's CVE-2024-27980 hardening a plain spawn/spawnSync refuses to exec a
// .cmd (ENOENT / EINVAL) unless shell:true is set — which we won't do (rawArgs
// would become a shell-injection surface). cross-spawn resolves the shim safely.
import { sync as spawnSync } from 'cross-spawn'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wrapCommandErrors, errorCode } from './lib/cli-errors'
import { forTerminal, humanCommand, stripAnsi } from './lib/cli-format'
import { stopActiveSpinner } from './lib/spinner'
import { printAction } from './lib/output'
import {
  findUnknownCommand,
  type CommandTreeNode,
  type UnknownCommand,
} from './lib/command-suggestions'
import { DEEPSPACE_ENV } from './env'
import login from './commands/login'
import logout from './commands/logout'
import dev from './commands/dev'
import kill from './commands/kill'
import test from './commands/test'
import screenshot from './commands/screenshot'
import testAccounts from './commands/test-accounts'
import deploy from './commands/deploy'
import undeploy from './commands/undeploy'
import whoami from './commands/whoami'
import apps from './commands/apps'
import logs from './commands/logs'
import usage from './commands/usage'
import add from './commands/add'
import domain from './commands/domain'
import appFiles from './commands/app-files'
import collaborators from './commands/collaborators'
import transfer from './commands/transfer'
import integrations from './commands/integrations'
import feedback from './commands/feedback'
import secrets from './commands/secrets'
import init from './commands/init'
import status from './commands/status'
import push from './commands/push'
import pull from './commands/pull'
import clone from './commands/clone'
import releases from './commands/releases'
import rollback from './commands/rollback'
import workspace from './commands/workspace'
import activity from './commands/activity'
import gitCredential from './commands/git-credential'
import source from './commands/source'
import update from './commands/update'

// Read own version from package.json so the CLI banner stays in sync with publishes.
// __dirname of the bundled output is <pkg>/dist; package.json sits one level up.
const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))

// workerd doesn't auto-discover system CAs in containers — outbound HTTPS to the
// auth/api workers fails with "TLS peer's certificate is not trusted" until we
// point it at the standard Debian/Ubuntu cert bundle. Harmless on macOS (path
// doesn't exist, env var not set).
if (
  process.platform === 'linux' &&
  !process.env.SSL_CERT_FILE &&
  existsSync('/etc/ssl/certs/ca-certificates.crt')
) {
  process.env.SSL_CERT_FILE = '/etc/ssl/certs/ca-certificates.crt'
}

const create = defineCommand({
  meta: {
    name: 'create',
    description: 'Create a new DeepSpace app (runs create-deepspace; all flags are forwarded)',
  },
  args: {
    name: {
      type: 'positional',
      description: 'App name',
      required: false,
    },
    interactive: {
      type: 'boolean',
      description: 'Prompt for options instead of using defaults',
    },
    template: {
      type: 'string',
      description: 'Starter template (default: starter)',
    },
    local: {
      type: 'string',
      description: 'Use a local SDK monorepo checkout instead of the published package',
    },
  },
  run({ rawArgs }) {
    // Forward EVERY argument verbatim and pin the scaffolder to this CLI's own
    // version — `npm create deepspace@latest` used to drop all flags and could
    // fetch a create-deepspace newer than the running CLI.
    const scaffolder = `create-deepspace@${pkg.version}`
    console.log(`Running: npx ${scaffolder} ${rawArgs.join(' ')}`.trimEnd() + '\n')
    const res = spawnSync('npx', ['-y', scaffolder, ...rawArgs], { stdio: 'inherit' })
    // Surface a spawn failure instead of exiting silently: with stdio:'inherit'
    // and a spawn error, res.status is null and `?? 1` would swallow the real
    // cause (npx missing from PATH, etc.) behind a bare exit 1.
    if (res.error) {
      const err = res.error as NodeJS.ErrnoException
      console.error(
        `Failed to run \`npx ${scaffolder}\`: ${err.message}` +
          (err.code === 'ENOENT' ? '\nIs Node.js (which provides npx) installed and on PATH?' : ''),
      )
      process.exit(1)
    }
    process.exit(res.status ?? 1)
  },
})

// ── command groups ──────────────────────────────────────────────────────────
// Command implementations keep their files; the key is the public name, and
// the spread re-stamps meta.name so group help renders the full tree.

const rename = <T extends { meta?: unknown }>(cmd: T, name: string): T =>
  ({ ...cmd, meta: { ...((cmd.meta ?? {}) as Record<string, unknown>), name } }) as T

const auth = defineCommand({
  meta: { name: 'auth', description: 'Session: login, logout, whoami' },
  subCommands: { login, logout, whoami },
})

const app = defineCommand({
  meta: {
    name: 'app',
    description:
      'The app itself: create, init, list, files, source, update, undeploy, transfer, collaborators, domain, usage',
  },
  subCommands: {
    create,
    init,
    list: rename(apps, 'list'),
    files: appFiles,
    undeploy,
    transfer,
    collaborators,
    domain,
    usage,
    source,
    update,
  },
})

const devGroup = defineCommand({
  meta: { name: 'dev', description: 'Local development' },
  subCommands: { start: rename(dev, 'start'), kill },
})
const testGroup = defineCommand({
  meta: { name: 'test', description: 'App tests and test tooling' },
  subCommands: {
    run: rename(test, 'run'),
    screenshot,
    accounts: rename(testAccounts, 'accounts'),
  },
})

const main = defineCommand({
  meta: {
    name: 'deepspace',
    version: pkg.version,
    description: 'DeepSpace SDK CLI',
  },
  subCommands: {
    status,
    activity,
    // Production log tail (arrived from main after the re-tree; a top-level
    // observability verb alongside `activity`, not an `app` subcommand — it
    // is a daily agent verb, and its --follow NDJSON stream is the same
    // documented exception `activity --follow` holds).
    logs,
    push,
    pull,
    clone,
    workspace,
    releases,
    rollback,
    deploy,
    dev: devGroup,
    test: testGroup,
    add,
    secrets,
    integrations,
    auth,
    app,
    feedback,
    'git-credential': gitCredential,
  },
  // No `run()` here — citty cascades parent run() AFTER subcommand finishes,
  // which corrupts agent-friendly output (`--json`) and prints noise on every
  // command. Citty's default behavior when no subcommand matches is to print
  // help, which is what we want for `deepspace` with no args.
})

// Escaped errors (API failures, network hiccups) render as one clean line
// instead of citty's default Error-object dump with a stack trace.
//
// For `--json` callers, drive runCommand ourselves: citty validates the argv and
// throws its own CLIError BEFORE run() executes, so a parse failure (missing
// required positional like `workspace attach` with no id, unknown command) never
// reaches a command's own --json catch — runMain would print the human usage
// page, which a machine consumer can't parse. Convert it into a coded JSON
// refusal. `--help`/`-h` still goes through runMain so help stays read-only and
// exits 0 regardless of --json (runCommand would ignore the flag and could run a
// mutating command); everything else keeps runMain's behavior untouched.
/**
 * Fail-fast unknown-command guard for the HUMAN path. citty's default for an
 * unknown (sub)command is to print usage and exit 0 — which lets a script or
 * agent driving a stale command surface read a typo as success. The --json
 * path already converts citty's E_UNKNOWN_COMMAND into a coded exit-1
 * refusal; this makes the exit-code contract uniform for everyone else.
 *
 * Walks the static subcommand tables only while tokens look like command
 * names: the first flag ends the walk (citty may still resolve a subcommand
 * placed after flags — that arrangement just isn't pre-checked), and a
 * command without subCommands consumes the rest of argv as its own args.
 */
function commandTree(): Record<string, CommandTreeNode> {
  return (main.subCommands ?? {}) as Record<string, CommandTreeNode>
}

function unknownCommandMessage(unknown: UnknownCommand): string {
  // humanCommand, not join(' '): a token containing spaces has to render
  // quoted, or `deepspace "auth whoami"` reports itself as its own suggestion.
  return (
    `Unknown command: ${humanCommand(unknown.attemptedPath)} — ` +
    `did you mean \`${humanCommand(unknown.suggestion)}\`?` +
    (unknown.quotedToken
      ? ' The whole command arrived as one quoted argument; pass each word separately.'
      : '')
  )
}

function assertKnownCommandPath(argv: string[]): void {
  const unknown = findUnknownCommand(argv, commandTree())
  if (!unknown) return
  console.error(
    `${unknownCommandMessage(unknown)}\n` +
      `Run \`${unknown.helpPath.join(' ')} --help\` for the command list.`,
  )
  if (unknown.executable) printAction({ cwd: process.cwd(), argv: unknown.suggestion })
  process.exit(1)
}

const rawArgs = process.argv.slice(2)
const wantsHelp = rawArgs.some((arg) => arg === '--help' || arg === '-h')
if (DEEPSPACE_ENV === 'invalid') {
  const error =
    `Invalid DEEPSPACE_ENV=${JSON.stringify(process.env.DEEPSPACE_ENV)}. ` +
    'Use `staging`, `production`, or unset it; refusing to default to production.'
  if (rawArgs.includes('--json') && !wantsHelp) {
    console.log(JSON.stringify({ ok: false, code: 'invalid_environment', error }))
  } else {
    console.error(error)
  }
  process.exit(1)
}
if (rawArgs.includes('--json') && !wantsHelp) {
  const unknown = findUnknownCommand(rawArgs, commandTree())
  if (unknown) {
    console.log(
      JSON.stringify({
        ok: false,
        code: 'unknown_command',
        error: unknownCommandMessage(unknown),
        ...(unknown.executable
          ? { action: { cwd: process.cwd(), argv: unknown.suggestion } }
          : {}),
      }),
    )
    process.exit(1)
  }
  runCommand(wrapCommandErrors(main), { rawArgs }).catch((err) => {
    stopActiveSpinner()
    // citty's CLIError carries a `.code` per condition; map each to its own
    // stable slug (EARG = a missing/invalid positional or flag). A genuinely
    // escaped run() error is already handled by wrapCommandErrors → renderCliError
    // and exits before this catch, so the errorCode() branch only guards the
    // rare non-citty throw that reaches here.
    const cittyCode =
      err instanceof Error && err.name === 'CLIError' ? (err as { code?: string }).code : undefined
    const code =
      cittyCode === 'EARG'
        ? 'missing_argument'
        : cittyCode === 'E_UNKNOWN_COMMAND'
          ? 'unknown_command'
          : cittyCode === 'E_NO_COMMAND'
            ? 'no_command'
            : errorCode(err)
    // citty colorizes some messages (cyan), so strip ANSI before it lands
    // in the machine-read string.
    const message = stripAnsi(err instanceof Error ? err.message : String(err))
    console.log(JSON.stringify({ ok: false, error: message, ...(code ? { code } : {}) }))
    process.exit(1)
  })
} else {
  // Static path validation is read-only, including for help probes. Without
  // it, `deepspace update --help` silently falls back to root help and exits
  // 0 even though the only valid path is `deepspace app update`.
  assertKnownCommandPath(rawArgs)
  // The only entry into citty's colorized rendering — every `--help` page and
  // every usage dump it prints on a parse error goes through showUsage. Keeps
  // citty's own shape: the trailing blank line, and a render failure reported
  // rather than thrown out of a help probe.
  runMain(wrapCommandErrors(main), {
    showUsage: async (cmd, parent) => {
      try {
        console.log(forTerminal(await renderUsage(cmd, parent)) + '\n')
      } catch (error) {
        console.error(error)
      }
    },
  })
}
