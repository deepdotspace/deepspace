/**
 * deepspace dev start [--port N]
 *
 * Starts local development:
 *   1. Ensures you're logged in
 *   2. Writes .dev.vars pointing to the production platform workers
 *   3. Starts vite dev (Cloudflare Vite plugin runs the worker in-process)
 *
 *   deepspace dev start                   # port 5173 (strict)
 *   deepspace dev start --port 5180       # bind to a different port (multi-app dev)
 *   deepspace dev start --host 0.0.0.0    # bind an explicit interface (containers)
 *
 * Port is `--port` > $DEEPSPACE_PORT > a stable linked-worktree port > 5173,
 * so Codex, Claude, and ordinary Git worktrees do not collide with a primary
 * checkout server. We always pass --strictPort to vite so a busy port
 * fails loudly instead of silently jumping to 5174 (which would diverge from
 * anything Playwright/test config is expecting).
 *
 * Defined with the command runtime (lib/command.ts) so every PREFLIGHT failure
 * (no app dir, logged out, port busy, secrets refresh) carries a slug and a
 * `--json` envelope. The server itself is long-running, so `--json` emits TWO
 * envelopes: a readiness line (`{"ok":true,"ready":true,"url":…}`) the moment
 * the port answers — the only moment a caller waiting to drive the server can
 * use — and the runtime's own result envelope once vite exits. Vite's output
 * streams through inherited stdio and is never buffered or suppressed, so the
 * exit envelope is the LAST line, not the only one.
 */

import { readAppId } from '../lib/app-identity'
import { resolve, basename, join } from 'node:path'
import spawn from 'cross-spawn'
import { ensureToken } from '../auth'
import { detectAppName, findAppDir, findChildApps } from '../lib/app-context'
import {
  detectClaudeWorktree,
  detectLinkedWorktree,
  deriveWorktreePort,
  upsertWorktreeLaunchConfig,
  writeLaunchConfigIfMissing,
} from '../lib/launch-config'
import { PLATFORM_URLS } from '../env'
import { writeDevVars } from '../lib/dev-vars'
import { decodeJwtPayload } from '../../shared/jwt'
import { ensureInstallReady } from '../lib/install-status'
import { preflightNodeVersion, preflightWindowsWorkerd } from '../lib/preflight'
import { removeMacosJunk } from '../lib/macos-junk'
import { refreshSecretsCache } from '../lib/secrets'
import { lintProjectSchemas, formatSchemaLintFindings } from '../lib/schema-lint'
import { DEFAULT_PORT, resolvePort, isPortListening, waitForPortListening } from '../lib/port'

/** What vite's bare `--host` means: every interface. */
const DEFAULT_DEV_HOST = '0.0.0.0'

/** Long enough for a cold vite + workerd start, short enough to still be news. */
const READINESS_TIMEOUT_MS = 120_000
import {
  prepareWranglerEnvConfig,
  wranglerViteEnv,
  type PreparedWranglerEnvConfig,
} from '../lib/wrangler-env'
import { cliAction, defineDeepspaceCommand, Refusal } from '../lib/command'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

/**
 * The "no wrangler.toml here" refusal, shared verbatim by `dev` and `test` —
 * the same `not_in_app_repo` code every other command gives this state.
 * Multi-line on purpose: the sibling-app suggestions are the whole point of
 * the message, and the runtime appends the slug to its last line.
 */
export function noAppDirRefusal(start: string): Refusal {
  const children = findChildApps(start)
  const lines = [`No wrangler.toml found at or above ${start}.`]
  if (children.length > 0) {
    lines.push('Did you mean to run inside one of these app directories?')
    for (const c of children) lines.push(`  cd ${c}`)
  } else {
    lines.push('Run from a DeepSpace app directory (one containing wrangler.toml).')
  }
  return new Refusal(lines.join('\n'), 'not_in_app_repo')
}

export function devExitSucceeded(code: number | null, stopping: boolean): boolean {
  return stopping || code === null || code === 0
}

export default defineDeepspaceCommand({
  meta: {
    name: 'dev',
    description: 'Start local development server',
  },
  args: {
    dir: {
      type: 'positional',
      description: 'App directory (default: current directory)',
      required: false,
    },
    env: {
      type: 'string',
      alias: 'e',
      description:
        'wrangler.toml [env.<name>] block to run (e.g. --env staging). ' +
        "Applies the env's overrides at build time.",
      required: false,
    },
    port: {
      type: 'string',
      description: `Port to bind (default ${DEFAULT_PORT}, or $DEEPSPACE_PORT)`,
      required: false,
    },
    host: {
      type: 'string',
      description: `Interface to bind (default ${DEFAULT_DEV_HOST} — reachable from outside a container)`,
      required: false,
    },
  },
  async run({ args }) {
    const say = (line: string) => {
      if (!args.json) console.log(line)
    }
    preflightNodeVersion('dev start')
    const wranglerEnv =
      typeof args.env === 'string' && args.env.trim() ? args.env.trim() : undefined
    const host =
      typeof args.host === 'string' && args.host.trim() ? args.host.trim() : DEFAULT_DEV_HOST

    // Resolve the app root by walking up from the requested dir (default cwd),
    // so running from a subdirectory still works instead of hard-failing.
    const start = resolve((args.dir as string | undefined) ?? '.')
    const appDir = findAppDir(start)
    if (!appDir) {
      throw noAppDirRefusal(start)
    }

    const junk = removeMacosJunk(appDir)
    if (junk > 0) say(`Removed ${junk} macOS metadata file(s) (._*, .DS_Store)`)

    // Inside a Claude Code worktree the desktop preview tool reads only the
    // MAIN repo's launch.json and would serve the main repo's stale code
    // (anthropics/claude-code#56688) — so upsert a cwd-pinned entry there.
    // Explicit --port and $DEEPSPACE_PORT are honored before any derived
    // worktree default. Otherwise a stable per-worktree port (bumped past
    // other Claude launch entries' ports)
    // avoids colliding with a main-repo server. This run binds the same port
    // the entry advertises, so the preview tool can attach to an
    // already-running worktree server instead of spawning a duplicate.
    const worktree = detectClaudeWorktree(appDir)
    const linkedWorktree = detectLinkedWorktree(appDir)
    const explicitPort = Boolean(args.port)
    const configuredPort = explicitPort || Boolean(process.env.DEEPSPACE_PORT)
    let port =
      linkedWorktree && !configuredPort
        ? deriveWorktreePort(linkedWorktree.worktreeRoot)
        : resolvePort(args.port as string | undefined)
    if (worktree) {
      const upserted = upsertWorktreeLaunchConfig(
        worktree.mainRepoRoot,
        worktree.worktreeName,
        appDir,
        {
          port,
          probePort: !configuredPort,
          extraArgs: [...(wranglerEnv ? ['--env', wranglerEnv] : [])],
        },
      )
      if (upserted) {
        port = upserted.port
        say(
          `Claude worktree detected — preview tool: use preview_start with name "${upserted.entryName}" (port ${upserted.port})`,
        )
      } else if (!args.json) {
        console.warn(
          `Warning: could not update ${join(worktree.mainRepoRoot, '.claude', 'launch.json')} ` +
            `(malformed or unwritable) — the Claude preview tool may serve the main repo's code ` +
            `instead of this worktree.`,
        )
      }
    }

    // Seed an app-local .claude/launch.json (only if absent) so the Claude Code
    // preview tool launches this app on the resolved port, instead of walking
    // up and latching onto an ancestor repo's config. With an explicit --port,
    // also update the existing entry so `kill` and the preview tool track the
    // port we actually bind (DEV-3).
    writeLaunchConfigIfMissing(appDir, detectAppName(appDir) ?? basename(appDir), port, {
      updatePort: explicitPort,
    })

    ensureInstallReady(appDir)

    // Surface schema-lint findings in the terminal the developer is watching.
    // The worker also warns at runtime, but only in the DO's console after a
    // client connects — easy to miss, and these are shipping privacy bugs.
    const lintFindings = await lintProjectSchemas(appDir)
    if (lintFindings && lintFindings.length > 0 && !args.json) {
      for (const line of formatSchemaLintFindings(lintFindings)) console.warn(line)
    }

    let token: string
    try {
      token = await ensureToken()
    } catch (err: unknown) {
      // Keep ensureToken's canonical wording ("Not logged in…" / "Session
      // expired…") and add the slug + the command that fixes it.
      throw new Refusal(err instanceof Error ? err.message : String(err), 'not_authenticated', {
        action: cliAction('deepspace', 'auth', 'login'),
      })
    }

    let payload: { sub: string; name?: string; email?: string }
    try {
      payload = decodeJwtPayload<{ sub: string; name?: string; email?: string }>(token)
    } catch {
      throw new Refusal(
        'Malformed session token. Run `npx deepspace auth login`.',
        'not_authenticated',
        { action: cliAction('deepspace', 'auth', 'login') },
      )
    }
    // `--env` selects which `[env.<name>]` block of wrangler.toml we apply
    // (renames the app, swaps vars, etc.). Surface it in the startup log so
    // it's obvious which app slot a session is hitting when it's set.
    say(`Logged in as ${payload.name ?? payload.email}`)
    if (wranglerEnv) say(`Wrangler env: ${wranglerEnv}`)
    say(`Port: ${port}`)
    if (host !== DEFAULT_DEV_HOST) say(`Host: ${host}`)

    // Refresh the app-store secrets cache (config = wrangler env, or 'prd').
    // A repo without a DEEPSPACE_APP_ID hasn't been initialized — writeDevVars
    // below throws with the `deepspace app init` pointer, so skip the pull.
    let generatedSecretsCache: string | undefined
    const appIdForSecrets = readAppId(appDir, wranglerEnv)
    if (appIdForSecrets) {
      try {
        const refreshed = await refreshSecretsCache(DEPLOY_URL, token, appIdForSecrets, wranglerEnv)
        generatedSecretsCache = refreshed.rendered
        if (refreshed.summary) say(refreshed.summary)
      } catch (err: unknown) {
        throw new Refusal(
          `Failed to refresh app secrets: ${err instanceof Error ? err.message : String(err)}`,
          'secrets_refresh_failed',
        )
      }
    }

    await writeDevVars(appDir, payload.sub, token, wranglerEnv, {
      generatedSecretsCache,
    })
    // prepareWranglerEnvConfig throws typed errors that already carry slugs;
    // let them through untouched rather than flattening them to a message.
    const wranglerConfig: PreparedWranglerEnvConfig = prepareWranglerEnvConfig(appDir, wranglerEnv)
    preflightWindowsWorkerd(appDir)

    // Pre-probe the port so a collision gets a friendly remedy instead of
    // vite's raw --strictPort EADDRINUSE stack trace (DEV-5). A connect probe,
    // because a bind probe on 127.0.0.1 reports "free" while another server
    // holds 0.0.0.0 — and vite then dies with the stack this exists to avoid.
    if (await isPortListening(port, host)) {
      const killArgv =
        port === DEFAULT_PORT
          ? ['deepspace', 'dev', 'kill']
          : ['deepspace', 'dev', 'kill', '--port', String(port)]
      const killCmd = killArgv.join(' ')
      wranglerConfig.cleanup()
      throw new Refusal(
        `Port ${port} is already in use.\n` +
          `Free it with \`${killCmd}\`, or start on another port: \`deepspace dev start --port <other>\`.`,
        'port_in_use',
        { extra: { port } },
      )
    }

    // 0.0.0.0 is a bind address, not an address to fetch — name the loopback
    // the caller can actually open.
    const url = `http://${host === DEFAULT_DEV_HOST ? 'localhost' : host}:${port}`
    say('Starting dev server...\n')

    // --clearScreen false: vite would otherwise wipe the CLI's own preflight
    // output (secrets summary, port choice) the moment it boots.
    const vite = spawn(
      'npx',
      ['vite', '--port', String(port), '--strictPort', '--host', host, '--clearScreen', 'false'],
      {
        cwd: appDir,
        stdio: 'inherit',
        env: wranglerViteEnv(process.env, wranglerConfig, { DEEPSPACE_PORT: String(port) }),
      },
    )
    // The readiness envelope. `--json` used to emit nothing until the server
    // had already exited, which is the one moment a caller waiting to drive it
    // cannot use. Printed the instant the port answers; the runtime's exit
    // envelope still lands last, as documented above.
    //
    // A timeout emits a REFUSAL rather than nothing: a caller blocking on this
    // line has no other signal, so silence would hang it for as long as vite
    // stays up. Not fatal — vite may still come up late, and the exit envelope
    // remains authoritative.
    //
    // The poller must not outlive vite: the runtime no longer force-exits
    // (lib/command.ts), so its ref'd probe socket/timer would hold the process
    // open for up to READINESS_TIMEOUT_MS after a vite that died before the
    // port ever answered. Aborted on vite close — silently, exactly like the
    // old process.exit: vite's exit envelope is the caller's signal then.
    const readiness = new AbortController()
    if (args.json) {
      void waitForPortListening(port, host, READINESS_TIMEOUT_MS, readiness.signal).then((ready) => {
        if (readiness.signal.aborted) return
        console.log(
          JSON.stringify(
            ready
              ? { ok: true, ready: true, url, port, host, appDir }
              : {
                  ok: false,
                  code: 'dev_server_not_ready',
                  error: `The dev server did not answer on ${url} within ${READINESS_TIMEOUT_MS / 1000}s.`,
                  url,
                  port,
                  host,
                  appDir,
                },
          ),
        )
      })
    }
    let stopping = false
    const stop = () => {
      stopping = true
      wranglerConfig.cleanup()
      vite.kill()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)

    // `dev` runs until vite exits (Ctrl-C, or a crash). Await that instead of
    // exiting from the close handler: the runtime owns exit codes now, and a
    // body that called process.exit would skip the envelope entirely.
    const code = await new Promise<number | null>((res) => {
      vite.on('close', (c) => {
        wranglerConfig.cleanup()
        res(c)
      })
    })
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    readiness.abort()
    // A signal-terminated vite reports code null — that's Ctrl-C, i.e. the
    // normal way this command ends, so it stays a success.
    if (!devExitSucceeded(code, stopping)) {
      throw new Refusal(`Dev server exited with code ${code}.`, 'dev_server_failed', {
        extra: { port, appDir, exitCode: code },
      })
    }
    return { data: { port, host, url, appDir, wranglerEnv: wranglerEnv ?? null } }
  },
})
