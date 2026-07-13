/**
 * DeepSpace CLI
 *
 * Commands:
 *   login    — authenticate with your DeepSpace account
 *   deploy   — build and deploy your app to *.app.space
 *   undeploy — remove a deployed app
 *   create   — redirects to `npm create deepspace`
 */

import { defineCommand, runMain } from 'citty'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wrapCommandErrors } from './lib/cli-errors'
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
import add from './commands/add'
import domain from './commands/domain'
import collaborators from './commands/collaborators'
import transfer from './commands/transfer'
import integrations from './commands/integrations'
import invoke from './commands/invoke'
import library from './commands/library'
import feedback from './commands/feedback'
import secrets from './commands/secrets'
import init from './commands/init'

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
    process.exit(res.status ?? 1)
  },
})

const main = defineCommand({
  meta: {
    name: 'deepspace',
    version: pkg.version,
    description: 'DeepSpace SDK CLI',
  },
  subCommands: {
    init,
    create,
    login,
    logout,
    whoami,
    apps,
    dev,
    kill,
    test,
    screenshot,
    'test-accounts': testAccounts,
    add,
    integrations,
    invoke,
    deploy,
    undeploy,
    domain,
    collaborators,
    transfer,
    library,
    feedback,
    secrets,
  },
  // No `run()` here — citty cascades parent run() AFTER subcommand finishes,
  // which corrupts agent-friendly output (`--json`) and prints noise on every
  // command. Citty's default behavior when no subcommand matches is to print
  // help, which is what we want for `deepspace` with no args.
})

// Escaped errors (API failures, network hiccups) render as one clean line
// instead of citty's default Error-object dump with a stack trace.
runMain(wrapCommandErrors(main))
