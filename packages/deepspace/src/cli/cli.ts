/**
 * DeepSpace CLI
 *
 * Commands:
 *   login    — authenticate with your DeepSpace account
 *   deploy   — build and deploy your app to *.app.space
 *   undeploy — remove a deployed app
 *   create   — redirects to `npm create deepspace`
 */

import { defineCommand, runMain, runCommand } from 'citty'
// cross-spawn, not node:child_process: on Windows `npx` is `npx.cmd`, and since
// Node's CVE-2024-27980 hardening a plain spawn/spawnSync refuses to exec a
// .cmd (ENOENT / EINVAL) unless shell:true is set — which we won't do (rawArgs
// would become a shell-injection surface). cross-spawn resolves the shim safely.
import { sync as spawnSync } from 'cross-spawn'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wrapCommandErrors, errorCode } from './lib/cli-errors'
import { stopActiveSpinner } from './lib/spinner'
import { printAction } from './lib/output'
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
import collaborators from './commands/collaborators'
import transfer from './commands/transfer'
import integrations from './commands/integrations'
import library from './commands/library'
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
      'The app itself: create, init, list, undeploy, transfer, collaborators, domain, library, usage',
  },
  subCommands: {
    create,
    init,
    list: rename(apps, 'list'),
    undeploy,
    transfer,
    collaborators,
    domain,
    library,
    usage,
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
/** Levenshtein distance, for the did-you-mean hint below. Inputs are command
 *  names (short), so the O(n·m) DP is trivially cheap. */
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...new Array<number>(b.length).fill(0),
  ])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[a.length][b.length]
}

function closestCommand(input: string, candidates: string[]): string | null {
  let best: string | null = null
  let bestDist = 4 // farther than 3 edits is a different word, not a typo
  for (const c of candidates) {
    const d = editDistance(input.toLowerCase(), c)
    if (d < bestDist) {
      best = c
      bestDist = d
    }
  }
  return best
}

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
function assertKnownCommandPath(argv: string[]): void {
  let table: Record<string, unknown> | undefined = main.subCommands as Record<string, unknown>
  let path = 'deepspace'
  for (const tok of argv) {
    if (!table || tok.startsWith('-')) return
    const entry: unknown = table[tok]
    if (!entry) {
      const hint = closestCommand(tok, Object.keys(table))
      console.error(
        `Unknown command: ${path} ${tok}${hint ? ` — did you mean \`${path} ${hint}\`?` : ''}\n` +
          `Run \`${path} --help\` for the command list.`,
      )
      if (hint) {
        printAction({ cwd: process.cwd(), argv: [...path.split(' '), hint] })
      }
      process.exit(1)
    }
    path += ` ${tok}`
    table = (entry as { subCommands?: Record<string, unknown> }).subCommands
  }
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
  const first = rawArgs.find((a) => !a.startsWith('-'))
  // Unknown top-level command: give the MACHINE caller the same did-you-mean
  // the human path gets — the consumer that most needs it. (Deeper paths fall
  // through to citty's E_UNKNOWN_COMMAND mapping below.)
  if (first && !Object.prototype.hasOwnProperty.call(main.subCommands ?? {}, first)) {
    const hint = closestCommand(first, Object.keys(main.subCommands ?? {}))
    console.log(
      JSON.stringify({
        ok: false,
        code: 'unknown_command',
        error: `Unknown command: deepspace ${first}${hint ? ` — did you mean \`deepspace ${hint}\`?` : ''}`,
        ...(hint ? { action: { cwd: process.cwd(), argv: ['deepspace', hint] } } : {}),
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
    // citty colorizes some messages (cyan) and its no-color check ignores a
    // non-TTY stdout, so strip ANSI before it lands in the machine-read string.
    const message = (err instanceof Error ? err.message : String(err)).replace(
      // eslint-disable-next-line no-control-regex
      /\u001b\[[0-9;]*m/g,
      '',
    )
    console.log(JSON.stringify({ ok: false, error: message, ...(code ? { code } : {}) }))
    process.exit(1)
  })
} else {
  // `--help` stays exempt so help probes remain read-only.
  if (!wantsHelp) assertKnownCommandPath(rawArgs)
  runMain(wrapCommandErrors(main))
}
