/**
 * Shared helper: read the current project's app name from `./wrangler.toml`.
 *
 * Used by commands that operate on "the current app" — `deploy`, `domain buy`,
 * `domain attach`, etc. Lets agents and scripts run from inside a project
 * directory without redundantly passing `--app <name>`.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { join, resolve, dirname, basename, isAbsolute, sep } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { APP_ID_RE, readAppId } from './app-identity'
import { apiFetch } from './api'

/** Strict app-id shape (excludes the legacy name-as-id branch of APP_ID_RE). */
const STRICT_APP_ID_RE = /^app_[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * Read the app name from `wrangler.toml` in the given directory (default cwd).
 * Returns null if no wrangler.toml exists or the file lacks a `name` field.
 */
export function detectAppName(cwd: string = process.cwd()): string | null {
  const wranglerPath = join(resolve(cwd), 'wrangler.toml')
  if (!existsSync(wranglerPath)) return null
  try {
    const cfg = parseToml(readFileSync(wranglerPath, 'utf-8')) as { name?: string }
    return typeof cfg.name === 'string' && cfg.name.length > 0 ? cfg.name : null
  } catch (err) {
    // Malformed is NOT absent — treating it as "no app here" sends callers
    // down create-new-app paths against a directory that has one.
    throw new Error(
      `Could not parse ${wranglerPath}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Resolve the app name from explicit arg or wrangler.toml.
 * Throws with a clear message if neither is available.
 */
export function requireAppName(explicit: string | undefined, cwd?: string): string {
  if (explicit) return explicit
  const detected = detectAppName(cwd)
  if (detected) return detected
  throw new Error(
    'No app specified. Pass --app <name>, or run from an app directory with a wrangler.toml.',
  )
}

/**
 * Walk upward from `start` (default cwd) to the nearest directory containing a
 * `wrangler.toml`, returning that directory — or null if none is found before
 * the filesystem root.
 *
 * This makes the dev-loop commands robust to being run from a *subdirectory*
 * of an app instead of hard-failing the moment cwd isn't exactly the app root.
 * (It does NOT recover the inverse case — cwd sitting at the app's *parent*;
 * for that, `findChildApps` powers a "did you mean cd <app>" hint.)
 */
export function findAppDir(start: string = process.cwd()): string | null {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, 'wrangler.toml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null // reached filesystem root
    dir = parent
  }
}

/**
 * Immediate subdirectories of `dir` that look like an app (contain a
 * `wrangler.toml`). Used to turn a bare "no wrangler.toml here" failure into an
 * actionable hint when the caller is sitting one level above the app — the
 * exact situation a harness creates when it resets cwd to the parent.
 */
export function findChildApps(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'wrangler.toml')))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

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
      runtimeArgs: ['deepspace', 'dev', '--port', String(port)],
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
 * Detect whether `appDir` lives inside a Claude Code worktree
 * (`<root>/.claude/worktrees/<name>/...`). Returns the main repo root (the
 * directory containing `.claude`) and the worktree name, or null.
 *
 * The Claude desktop preview tool starts dev servers from the session's
 * primary working directory and reads only the MAIN repo's
 * `.claude/launch.json` — a worktree's own launch.json is never read
 * (anthropics/claude-code#56688). Detecting this lets `dev` seed a
 * `cwd`-pinned entry where the tool will actually look.
 */
export function detectClaudeWorktree(
  appDir: string,
): { mainRepoRoot: string; worktreeName: string } | null {
  const segments = resolve(appDir).split(sep)
  // Innermost match wins: worktrees are created under the *session root's*
  // .claude/worktrees, so a nested worktree implies the session is rooted at
  // the outer worktree — that outer root's launch.json is the one the
  // session's preview tool reads.
  for (let i = segments.length - 3; i >= 1; i--) {
    if (segments[i] === '.claude' && segments[i + 1] === 'worktrees' && segments[i + 2]) {
      return {
        mainRepoRoot: segments.slice(0, i).join(sep) || sep,
        worktreeName: segments[i + 2],
      }
    }
  }
  return null
}

const WORKTREE_ENTRY_PREFIX = 'wt-'
const WORKTREE_PORT_MIN = 5180
const WORKTREE_PORT_RANGE = 20

/**
 * Deterministic per-worktree preview port in the worktree band
 * (5180–5199), distinct from the default 5173 so a preview server for the
 * worktree never collides with a main-repo dev server. Stable across runs
 * for the same worktree name. Hash collisions between worktree names are
 * resolved at write time by `upsertWorktreeLaunchConfig`, which probes past
 * ports already claimed by other launch.json entries.
 */
export function deriveWorktreePort(worktreeName: string): number {
  let hash = 0
  for (const ch of worktreeName) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return WORKTREE_PORT_MIN + (hash % WORKTREE_PORT_RANGE)
}

export interface WorktreeLaunchOptions {
  /** Desired port for the entry (and for the current dev run). */
  port: number
  /**
   * When true, bump the port past any port already claimed by another
   * launch.json entry (wrapping within 5180–5199). Off for an explicit
   * --port, which is honored verbatim.
   */
  probePort?: boolean
  /** Extra `deepspace dev` args to preserve in the entry (e.g. --prod, --env). */
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
        config.configurations.map((c) => Number(c?.port)).filter((p) => Number.isInteger(p) && p > 0),
      )
      for (let i = 0; i < WORKTREE_PORT_RANGE && taken.has(port); i++) {
        port = WORKTREE_PORT_MIN + ((port - WORKTREE_PORT_MIN + 1) % WORKTREE_PORT_RANGE)
      }
    }

    config.configurations.push({
      name: entryName,
      runtimeExecutable: 'npx',
      runtimeArgs: ['deepspace', 'dev', '--port', String(port), ...(opts.extraArgs ?? [])],
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
 * The port dev/test/kill should default to inside a Claude Code worktree, so
 * all three commands target the same server (`test` against a different port
 * silently exercises the main repo's code via Playwright's
 * reuseExistingServer). The `wt-<name>` entry in the main repo's launch.json
 * is the source of truth — it includes any probing `dev` applied; fall back
 * to the derived port when it doesn't exist yet. Returns null outside a
 * worktree.
 */
export function resolveWorktreePort(appDir: string): number | null {
  const worktree = detectClaudeWorktree(appDir)
  if (!worktree) return null
  try {
    const config = readLaunchFile(join(worktree.mainRepoRoot, '.claude', 'launch.json'))
    const entry = config?.configurations.find(
      (c) => c?.name === WORKTREE_ENTRY_PREFIX + worktree.worktreeName,
    )
    const port = Number(entry?.port)
    if (Number.isInteger(port) && port > 0) return port
  } catch {
    // malformed launch.json — fall through to the derived port
  }
  return deriveWorktreePort(worktree.worktreeName)
}

/**
 * Resolve the app id a command targets: an explicit `--app app_…` wins,
 * otherwise the surrounding app directory's DEEPSPACE_APP_ID. Shared by
 * `collaborators`, `transfer`, and other id-scoped commands.
 */
export function requireAppIdArg(explicit: string | undefined): string {
  if (explicit) {
    if (!APP_ID_RE.test(explicit)) {
      throw new Error(`"${explicit}" is not an app id (app_…). Pass --app <appId>.`)
    }
    return explicit
  }
  const appDir = findAppDir()
  const id = appDir ? readAppId(appDir) : null
  if (!id) {
    throw new Error(
      'No app id. Run from an app directory whose wrangler.toml carries DEEPSPACE_APP_ID, or pass --app <appId>.',
    )
  }
  return id
}

interface AppListEntry {
  appId: string
  name: string | null
}

/** Find an app id or subdomain name in the caller's registry list. Exported for tests. */
export function matchAppSelector(apps: AppListEntry[], selector: string): string | null {
  const byId = apps.find((a) => a.appId === selector)
  if (byId) return byId.appId
  const byName = apps.find((a) => a.name === selector)
  if (byName) return byName.appId
  // Not among the caller's apps. A well-formed app_… id is trusted as-is (e.g.
  // an app the list didn't surface); anything else is an unknown name.
  return STRICT_APP_ID_RE.test(selector) ? selector : null
}

/**
 * Resolve an app selector — an app id (`app_…` or a legacy name-as-id) OR a live
 * subdomain name — to the canonical app id, via the deploy worker's `/api/apps`
 * registry. Unifies the "id vs name" split (DEP-4/DEP-5): id-scoped commands now
 * accept either. Throws a `deepspace apps` pointer when nothing matches.
 */
export async function resolveAppSelector(
  deployUrl: string,
  token: string,
  selector: string,
): Promise<string> {
  // A canonical app_… id needs no registry lookup — trust it and let the target
  // worker authorize it. This skips an extra round-trip and, for the API-worker
  // commands (collaborators/transfer), a needless dependency on the deploy
  // worker's /api/apps. Legacy name-as-id and subdomain names still need it.
  if (STRICT_APP_ID_RE.test(selector)) return selector
  const { apps } = await apiFetch<{ apps: AppListEntry[] }>(deployUrl, token, '/api/apps')
  const id = matchAppSelector(apps, selector)
  if (!id) {
    throw new Error(`No app "${selector}" in your account. Run \`deepspace apps\` to list your apps.`)
  }
  return id
}

/**
 * The app id a command targets: an explicit `--app` selector (id or name,
 * resolved via resolveAppSelector) wins; otherwise the surrounding app
 * directory's DEEPSPACE_APP_ID. The async, name-accepting counterpart of
 * requireAppIdArg (DEP-4).
 */
export async function resolveAppTarget(
  deployUrl: string,
  token: string,
  explicit: string | undefined,
): Promise<string> {
  if (explicit) return resolveAppSelector(deployUrl, token, explicit)
  const appDir = findAppDir()
  const id = appDir ? readAppId(appDir) : null
  if (!id) {
    throw new Error(
      'No app id. Run from an app directory whose wrangler.toml carries DEEPSPACE_APP_ID, or pass --app <id or name>.',
    )
  }
  return id
}
