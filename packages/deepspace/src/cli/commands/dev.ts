/**
 * deepspace dev [--port N]
 *
 * Starts local development:
 *   1. Ensures you're logged in
 *   2. Writes .dev.vars pointing to the production platform workers
 *   3. Starts vite dev (Cloudflare Vite plugin runs the worker in-process)
 *
 *   deepspace dev                   # port 5173 (strict)
 *   deepspace dev --port 5180       # bind to a different port (multi-app dev)
 *
 * Port is `--port` > $DEEPSPACE_PORT > 5173 — except inside a Claude Code
 * worktree, where (unless --port was passed) a stable per-worktree port in
 * 5180–5199 is derived instead, so the preview server never collides with a
 * main-repo dev server. We always pass --strictPort to vite so a busy port
 * fails loudly instead of silently jumping to 5174 (which would diverge from
 * anything Playwright/test config is expecting).
 */

import { defineCommand } from 'citty'
import { readAppId } from '../lib/app-identity'
import { resolve, basename, join } from 'node:path'
import spawn from 'cross-spawn'
import { ensureToken } from '../auth'
import {
  detectAppName,
  detectClaudeWorktree,
  deriveWorktreePort,
  findAppDir,
  findChildApps,
  upsertWorktreeLaunchConfig,
  writeLaunchConfigIfMissing,
} from '../lib/app-context'
import { PLATFORM_URLS, writeDevVars } from '../env'
import { decodeJwtPayload } from '../jwt'
import { ensureInstallReady } from '../lib/install-status'
import { preflightNodeVersion, preflightWindowsWorkerd } from '../lib/preflight'
import { removeMacosJunk } from '../lib/macos-junk'
import { refreshSecretsCache } from '../lib/secrets'
import { DEFAULT_PORT, resolvePort, checkPortAvailable } from '../lib/port'
import {
  prepareWranglerEnvConfig,
  wranglerViteEnv,
  type PreparedWranglerEnvConfig,
} from '../lib/wrangler-env'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

export default defineCommand({
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
  },
  async run({ args }) {
    preflightNodeVersion('dev')
    const wranglerEnv =
      typeof args.env === 'string' && args.env.trim() ? args.env.trim() : undefined

    // Resolve the app root by walking up from the requested dir (default cwd),
    // so running from a subdirectory still works instead of hard-failing.
    const start = resolve(args.dir ?? '.')
    const appDir = findAppDir(start)
    if (!appDir) {
      console.error(`No wrangler.toml found at or above ${start}.`)
      const children = findChildApps(start)
      if (children.length > 0) {
        console.error('Did you mean to run inside one of these app directories?')
        for (const c of children) console.error(`  cd ${c}`)
      } else {
        console.error('Run from a DeepSpace app directory (one containing wrangler.toml).')
      }
      process.exit(1)
    }

    const junk = removeMacosJunk(appDir)
    if (junk > 0) console.log(`Removed ${junk} macOS metadata file(s) (._*, .DS_Store)`)

    // Inside a Claude Code worktree the desktop preview tool reads only the
    // MAIN repo's launch.json and would serve the main repo's stale code
    // (anthropics/claude-code#56688) — so upsert a cwd-pinned entry there.
    // Only a literal --port counts as explicit and is honored verbatim: an
    // ambient $DEEPSPACE_PORT (e.g. exported in a shell profile) must not pin
    // the worktree to the main repo's port — the port is resolved AFTER
    // worktree detection so a malformed ambient value can't kill dev either.
    // Otherwise a stable per-worktree port (bumped past other entries' ports)
    // avoids colliding with a main-repo server. This run binds the same port
    // the entry advertises, so the preview tool can attach to an
    // already-running worktree server instead of spawning a duplicate.
    const worktree = detectClaudeWorktree(appDir)
    const explicitPort = Boolean(args.port)
    let port =
      worktree && !explicitPort ? deriveWorktreePort(worktree.worktreeName) : resolvePort(args.port)
    if (worktree) {
      const upserted = upsertWorktreeLaunchConfig(
        worktree.mainRepoRoot,
        worktree.worktreeName,
        appDir,
        {
          port,
          probePort: !explicitPort,
          extraArgs: [...(wranglerEnv ? ['--env', wranglerEnv] : [])],
        },
      )
      if (upserted) {
        port = upserted.port
        console.log(
          `Claude worktree detected — preview tool: use preview_start with name "${upserted.entryName}" (port ${upserted.port})`,
        )
      } else {
        console.warn(
          `Warning: could not update ${join(worktree.mainRepoRoot, '.claude', 'launch.json')} ` +
            `(malformed or unwritable) — the Claude preview tool may serve the main repo's code ` +
            `instead of this worktree.`,
        )
      }
      if (!explicitPort && process.env.DEEPSPACE_PORT) {
        console.log(
          `Ignoring DEEPSPACE_PORT=${process.env.DEEPSPACE_PORT} inside a worktree — ` +
            `using per-worktree port ${port}. Pass --port to override.`,
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

    let token: string
    try {
      token = await ensureToken()
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    let payload: { sub: string; name?: string; email?: string }
    try {
      payload = decodeJwtPayload<{ sub: string; name?: string; email?: string }>(token)
    } catch {
      console.error('Malformed session token. Run `npx deepspace login`.')
      process.exit(1)
    }
    // `--env` selects which `[env.<name>]` block of wrangler.toml we apply
    // (renames the app, swaps vars, etc.). Surface it in the startup log so
    // it's obvious which app slot a session is hitting when it's set.
    console.log(`Logged in as ${payload.name ?? payload.email}`)
    if (wranglerEnv) console.log(`Wrangler env: ${wranglerEnv}`)
    console.log(`Port: ${port}`)

    // Refresh the app-store secrets cache (config = wrangler env, or 'prd').
    // A repo without a DEEPSPACE_APP_ID hasn't been initialized — writeDevVars
    // below throws with the `deepspace init` pointer, so skip the pull.
    let generatedSecretsCache: string | undefined
    const appIdForSecrets = readAppId(appDir, wranglerEnv)
    if (appIdForSecrets) {
      try {
        const refreshed = await refreshSecretsCache(DEPLOY_URL, token, appIdForSecrets, wranglerEnv)
        if (refreshed) {
          generatedSecretsCache = refreshed.rendered
          console.log(refreshed.summary)
        }
      } catch (err: unknown) {
        console.error(
          `Failed to refresh app secrets: ${err instanceof Error ? err.message : String(err)}`,
        )
        process.exit(1)
      }
    }

    const sharedDevVarsCache = generatedSecretsCache !== undefined
    await writeDevVars(appDir, payload.sub, token, wranglerEnv, {
      generatedSecretsCache,
      sharedDevVarsCache,
    })
    let wranglerConfig: PreparedWranglerEnvConfig
    try {
      wranglerConfig = prepareWranglerEnvConfig(appDir, wranglerEnv, { sharedDevVarsCache })
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
    preflightWindowsWorkerd(appDir)

    // Pre-probe the port so a collision gets a friendly remedy instead of
    // vite's raw --strictPort EADDRINUSE stack trace (DEV-5).
    if (!(await checkPortAvailable(port))) {
      console.error(`Port ${port} is already in use.`)
      const killCmd = port === DEFAULT_PORT ? 'deepspace kill' : `deepspace kill --port ${port}`
      console.error(`Free it with \`${killCmd}\`, or start on another port: \`deepspace dev --port <other>\`.`)
      process.exit(1)
    }

    console.log('Starting dev server...\n')

    const vite = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host'], {
      cwd: appDir,
      stdio: 'inherit',
      env: wranglerViteEnv(process.env, wranglerConfig, { DEEPSPACE_PORT: String(port) }),
    })
    const stop = () => {
      wranglerConfig.cleanup()
      vite.kill()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    vite.on('close', (code) => {
      wranglerConfig.cleanup()
      process.exit(code ?? 0)
    })
  },
})
