/** Claude preview launch configuration for local apps and worktrees. */

import {
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { join, resolve, dirname, basename, isAbsolute, sep } from 'node:path'
import { detectAppName } from './app-context'
import { listWorktrees, repoToplevel } from './git/repository'

/**
 * Atomic launch.json write: temp file + rename, so an interrupted write can
 * never leave torn (permanently unparseable) JSON behind.
 */
function writeLaunchFile(launchPath: string, config: unknown): void {
  mkdirSync(dirname(launchPath), { recursive: true })
  const tmpPath = `${launchPath}.${process.pid}.tmp`
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n')
  try {
    renameSync(tmpPath, launchPath)
  } catch (err) {
    // Don't leave an orphan tmp file behind (e.g. Windows EPERM while the
    // preview tool holds launch.json open).
    try {
      unlinkSync(tmpPath)
    } catch {
      // best-effort cleanup
    }
    throw err
  }
}

/**
 * Read + validate a launch.json. Returns the parsed config, an empty skeleton
 * when the file is absent or empty (interrupted write, `touch` — nothing to
 * preserve), or null when it exists but is malformed / wrong-shaped (leave it
 * alone rather than clobber a hand-edited file). Trimmed before parsing so a
 * UTF-8 BOM from Windows editors doesn't read as "malformed".
 */
function readLaunchFile(
  launchPath: string,
): { version?: string; configurations: Array<Record<string, unknown>> } | null {
  const empty = { version: '0.0.1', configurations: [] }
  if (!existsSync(launchPath)) return empty
  const raw = readFileSync(launchPath, 'utf-8').trim()
  if (!raw) return empty
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.configurations)) return null
  return parsed
}

/**
 * Seed the app's own entry in `<appDir>/.claude/launch.json` so the Claude
 * Code preview tool launches THIS app. Without an app-local launch.json the
 * tool walks up the directory tree and can latch onto an ancestor repo's
 * config — pointing at a different app and port — which is a real failure
 * when a DeepSpace app lives inside another repo.
 *
 * Entry-level, not file-level: if the file already has an entry named
 * `appName` (possibly user-customized) it is left untouched by default, but a
 * file that exists without it — e.g. created by a worktree run's upsert before
 * the main app ever ran `dev` — still gets the app's entry appended.
 *
 * `opts.updatePort` (DEV-3): when the user passed an explicit `--port`, update
 * the existing entry's `port` and the `--port` value inside its `runtimeArgs`
 * (other args like `--env` are preserved) so `kill` and the preview tool track
 * the port `dev` actually bound. Without it, a scaffold pinned to 5173 would
 * stay stale after `dev --port 5180`. Best-effort: a failure must never block
 * `dev` from starting.
 */
export function writeLaunchConfigIfMissing(
  appDir: string,
  appName: string,
  port: number,
  opts: { updatePort?: boolean } = {},
): void {
  const launchPath = join(appDir, '.claude', 'launch.json')
  try {
    const config = readLaunchFile(launchPath)
    if (!config) return
    const existing = config.configurations.find((c) => c?.name === appName)
    if (existing) {
      if (!opts.updatePort) return
      // Resync BOTH the `port` field and the `--port` value in runtimeArgs — a
      // stale runtimeArgs (even when the port field matches) makes the preview
      // tool launch on the wrong port. Only write when something actually changed.
      let changed = false
      if (Number(existing.port) !== port) {
        existing.port = port
        changed = true
      }
      if (Array.isArray(existing.runtimeArgs)) {
        const ra = existing.runtimeArgs.map(String)
        const pi = ra.indexOf('--port')
        if (pi >= 0 && pi + 1 < ra.length) {
          if (ra[pi + 1] !== String(port)) {
            ra[pi + 1] = String(port)
            changed = true
          }
        } else {
          ra.push('--port', String(port))
          changed = true
        }
        if (changed) existing.runtimeArgs = ra
      }
      if (changed) writeLaunchFile(launchPath, config)
      return
    }
    config.configurations.push({
      name: appName,
      runtimeExecutable: 'npx',
      runtimeArgs: ['deepspace', 'dev', 'start', '--port', String(port)],
      port,
    })
    writeLaunchFile(launchPath, config)
  } catch {
    // best-effort only
  }
}

/**
 * The port `kill` should target for the app at `appDir` when no `--port` was
 * given and we're not in a worktree (DEV-2): the port recorded in the app's own
 * `.claude/launch.json` entry, which `dev --port` keeps in sync (see above).
 * Falls back to null (caller uses the default) when there's no launch.json,
 * no matching entry, or a malformed file.
 */
export function resolveAppLaunchPort(appDir: string): number | null {
  try {
    const config = readLaunchFile(join(appDir, '.claude', 'launch.json'))
    if (!config) return null
    const appName = detectAppName(appDir) ?? basename(appDir)
    const entry =
      config.configurations.find((c) => c?.name === appName) ??
      (config.configurations.length === 1 ? config.configurations[0] : undefined)
    const port = Number(entry?.port)
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

/**
 * Detect whether `appDir` lives inside a registered Git worktree created at
 * `<root>/.claude/worktrees/<name>`. Returns the checkout whose `.claude`
 * directory owns that worktree and the worktree name, or null.
 *
 * The Claude desktop preview tool starts dev servers from the session's
 * primary working directory and reads only the MAIN repo's
 * `.claude/launch.json` — a worktree's own launch.json is never read
 * (anthropics/claude-code#56688). Detecting this lets `dev` seed a
 * `cwd`-pinned entry where the tool will actually look. The path shape alone
 * is deliberately insufficient: both the child and inferred owner must be
 * registered checkouts of the same repository. That prevents an ordinary
 * directory merely named `.claude/worktrees/<name>` from changing ports or
 * mutating an unrelated ancestor's launch configuration.
 */
export function detectClaudeWorktree(
  appDir: string,
): { mainRepoRoot: string; worktreeName: string } | null {
  try {
    // Git owns the worktree boundary. `appDir` may be any nested app path, so
    // never infer that boundary from path segments.
    const worktreeRoot = canonicalPath(repoToplevel(appDir))
    const registered = new Set(
      listWorktrees(appDir).map((worktree) => canonicalPath(worktree.path)),
    )
    if (!registered.has(worktreeRoot)) return null

    const worktreesDir = dirname(worktreeRoot)
    const claudeDir = dirname(worktreesDir)
    if (basename(worktreesDir) !== 'worktrees' || basename(claudeDir) !== '.claude') return null

    // For a nested Claude worktree, the owner may itself be a linked worktree.
    // Requiring it in `git worktree list` keeps the innermost-session behavior
    // without trusting a coincidental directory name.
    const ownerRoot = canonicalPath(dirname(claudeDir))
    if (!registered.has(ownerRoot)) return null

    return { mainRepoRoot: ownerRoot, worktreeName: basename(worktreeRoot) }
  } catch {
    // Non-Git directories, stale worktree registrations, and unreadable paths
    // are ordinary "not a Claude worktree" states.
    return null
  }
}

export interface LinkedWorktree {
  worktreeRoot: string
  mainRepoRoot: string
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // One stale unrelated registration must not disable the active checkout.
    return resolve(path)
  }
}

/** Detect any registered linked Git worktree, independent of agent or layout. */
export function detectLinkedWorktree(appDir: string): LinkedWorktree | null {
  try {
    const worktreeRoot = canonicalPath(repoToplevel(appDir))
    const registered = listWorktrees(appDir).map((worktree) => canonicalPath(worktree.path))
    const currentIndex = registered.indexOf(worktreeRoot)
    if (currentIndex <= 0 || !registered[0]) return null
    return { worktreeRoot, mainRepoRoot: registered[0] }
  } catch {
    return null
  }
}

const WORKTREE_ENTRY_PREFIX = 'wt-'
const WORKTREE_PORT_MIN = 5180
const WORKTREE_PORT_RANGE = 1000

/**
 * Deterministic per-worktree preview port in the worktree band
 * (5180–6179), distinct from the default 5173 so a preview server for the
 * worktree never collides with a main-repo dev server. Stable across runs
 * for the same canonical worktree path. Hash collisions between worktrees are
 * resolved at write time by `upsertWorktreeLaunchConfig`, which probes past
 * ports already claimed by other launch.json entries.
 */
export function deriveWorktreePort(worktreeKey: string): number {
  let hash = 0
  for (const ch of worktreeKey) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return WORKTREE_PORT_MIN + (hash % WORKTREE_PORT_RANGE)
}

export interface WorktreeLaunchOptions {
  /** Desired port for the entry (and for the current dev run). */
  port: number
  /**
   * When true, bump the port past any port already claimed by another
   * launch.json entry (wrapping within 5180–6179). Off for an explicit
   * --port, which is honored verbatim.
   */
  probePort?: boolean
  /** Extra `deepspace dev start` args to preserve in the entry (e.g. --prod, --env). */
  extraArgs?: string[]
}

/**
 * Upsert a `cwd`-pinned entry named `wt-<worktreeName>` into the MAIN repo's
 * `.claude/launch.json`, so the Claude desktop preview tool (which only reads
 * that file) starts the dev server inside the worktree instead of serving the
 * main repo's stale code. Also prunes `wt-*` entries whose absolute `cwd` no
 * longer exists (deleted worktrees) — relative `cwd`s are left alone, since
 * `existsSync` would resolve them against this process's cwd, not the
 * preview tool's. All other entries are preserved verbatim.
 *
 * Returns the entry name and the (possibly probed) port on success, or null
 * if the file was malformed or unwritable — best-effort: must never block
 * `dev` from starting, but the caller should warn, since a missing entry
 * means the preview tool will serve the main repo's code.
 */
export function upsertWorktreeLaunchConfig(
  mainRepoRoot: string,
  worktreeName: string,
  appDir: string,
  opts: WorktreeLaunchOptions,
): { entryName: string; port: number } | null {
  const launchPath = join(mainRepoRoot, '.claude', 'launch.json')
  const entryName = WORKTREE_ENTRY_PREFIX + worktreeName
  try {
    const config = readLaunchFile(launchPath)
    if (!config) return null
    // Ownership check for pruning: only entries whose cwd lives under this
    // repo's .claude/worktrees/ could have been written by us. A hand-authored
    // wt-* entry pointing elsewhere (or at an unmounted volume) is never ours
    // to delete.
    const worktreesRoot = join(mainRepoRoot, '.claude', 'worktrees') + sep
    config.configurations = config.configurations.filter((c) => {
      if (c?.name === entryName) return false // replaced below
      const isStaleWorktreeEntry =
        typeof c?.name === 'string' &&
        c.name.startsWith(WORKTREE_ENTRY_PREFIX) &&
        typeof c.cwd === 'string' &&
        isAbsolute(c.cwd) &&
        c.cwd.startsWith(worktreesRoot) &&
        !existsSync(c.cwd)
      return !isStaleWorktreeEntry
    })

    let port = opts.port
    if (opts.probePort) {
      // Number() coercion so a hand-edited string port ("5186") still counts
      // as claimed.
      const taken = new Set(
        config.configurations
          .map((c) => Number(c?.port))
          .filter((p) => Number.isInteger(p) && p > 0),
      )
      for (let i = 0; i < WORKTREE_PORT_RANGE && taken.has(port); i++) {
        port = WORKTREE_PORT_MIN + ((port - WORKTREE_PORT_MIN + 1) % WORKTREE_PORT_RANGE)
      }
    }

    config.configurations.push({
      name: entryName,
      runtimeExecutable: 'npx',
      runtimeArgs: ['deepspace', 'dev', 'start', '--port', String(port), ...(opts.extraArgs ?? [])],
      port,
      // `cwd` is honored verbatim by the desktop preview tool (documented in
      // the Claude Code desktop launch.json reference alongside `port`) and
      // verified end-to-end: with it set, the preview server builds from the
      // worktree instead of the session's main repo.
      cwd: resolve(appDir),
    })
    writeLaunchFile(launchPath, config)
    return { entryName, port }
  } catch {
    return null
  }
}

/**
 * The port dev/test/kill should default to inside any linked Git worktree, so
 * all three commands target the same server (`test` against a different port
 * silently exercises the main repo's code via Playwright's
 * reuseExistingServer). A Claude worktree's `wt-<name>` entry remains the
 * source of truth when present; every other linked worktree derives a stable
 * port from its canonical checkout path. Returns null in the primary checkout.
 */
export function resolveWorktreePort(appDir: string): number | null {
  const linked = detectLinkedWorktree(appDir)
  if (!linked) return null
  const claude = detectClaudeWorktree(appDir)
  if (claude) {
    try {
      const config = readLaunchFile(join(claude.mainRepoRoot, '.claude', 'launch.json'))
      const entry = config?.configurations.find(
        (c) => c?.name === WORKTREE_ENTRY_PREFIX + claude.worktreeName,
      )
      const port = Number(entry?.port)
      if (Number.isInteger(port) && port > 0) return port
    } catch {
      // malformed launch.json — fall through to the generic derived port
    }
  }
  return deriveWorktreePort(linked.worktreeRoot)
}
