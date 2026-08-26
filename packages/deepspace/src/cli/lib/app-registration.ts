/**
 * App registration — minting the server-registered id and stamping it into
 * wrangler.toml. Nothing registers "at the beginning": the ONE chokepoint
 * every verb resolves its local app through ({@link ensureAppRegistered}, via
 * `resolveAppTarget`) heals an id-less checkout by registering it on first
 * use, so `npm create` → `secrets set` → `deploy` (in any order) never needs
 * an explicit `deepspace app init`. `app init` remains the explicit spelling,
 * and the only path that can REPLACE an id (`--new-id` forks).
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DEEPSPACE_ENV, PLATFORM_URLS } from '../env'
import { apiFetch } from './api'
import { readAppId, writeAppId } from './app-identity'
import { runGit } from './git/process'
import { ensureGitIdentity } from './vc-remote'
import { hasWranglerConfig, readAppIdVar, readWranglerConfig } from './wrangler-env'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

/**
 * Mint a fresh server-registered app id and stamp it into wrangler.toml —
 * THE registration. Commits an unborn scaffold so the id's write is not left
 * dangling in a repo with no history.
 */
export async function mintAppIdentity(
  appDir: string,
  token: string,
  opts: { wranglerEnv?: string; force?: boolean; commitScaffold?: boolean } = {},
): Promise<{ appId: string; committedScaffold: boolean }> {
  const { appId } = await apiFetch<{ appId: string }>(DEPLOY_URL, token, '/api/apps/mint', {
    method: 'POST',
  })
  try {
    writeAppId(appDir, appId, { wranglerEnv: opts.wranglerEnv, force: Boolean(opts.force) })
  } catch (error) {
    // The app is registered server-side by this point; a failed local write
    // must name the id or the registration is orphaned with no way back.
    throw new Error(
      `Registered ${appId}, but writing it to wrangler.toml failed: ` +
        `${error instanceof Error ? error.message : String(error)} — add ` +
        `DEEPSPACE_APP_ID = "${appId}" ${opts.wranglerEnv ? `to [env.${opts.wranglerEnv}.vars] ` : ''}by hand.`,
    )
  }
  // Only the verbs whose PURPOSE is creating the app (`app init`, `deploy`)
  // commit the unborn scaffold. Everything else — the resolver healing a
  // `secrets set` or a `logs` — must never author commits: `git add -A` from
  // a read verb bypasses hooks and push's own secret-file scans.
  const committedScaffold = opts.commitScaffold === true && commitScaffoldIfUnborn(appDir, token)
  return { appId, committedScaffold }
}

/**
 * Whether an absent id here may be healed by minting: the target section must
 * DECLARE `DEEPSPACE_APP_ID` (the scaffold ships it as the `__APP_ID__`
 * placeholder). Declared-but-unset is the one state that unambiguously means
 * "a DeepSpace app awaiting its id". Everything else refuses exactly as
 * before — no wrangler.toml, an unrelated Cloudflare Workers repo whose
 * config never mentions DeepSpace (minting would rewrite a stranger's
 * wrangler.toml), and a typo'd `--env` name (`no_app_id_for_env`).
 */
export function canHealAppRegistration(appDir: string, wranglerEnv?: string): boolean {
  if (!hasWranglerConfig(appDir)) return false
  try {
    const cfg = readWranglerConfig(appDir)
    if (wranglerEnv && cfg.env?.[wranglerEnv] === undefined) return false
    if (readAppIdVar(cfg, wranglerEnv) === undefined) return false
  } catch {
    // An unreadable wrangler.toml is its own failure; let readAppId report it.
    return false
  }
  // A placeholder COMMITTED to history is a shared-repo state, not a fresh
  // scaffold: every teammate's clone would silently mint its own app on
  // first use, none of them the app the repo is about. Refuse (the old
  // explicit-step behavior) — the repo's owner should register once and
  // commit the real id, or a deliberate fork uses `app init`. A fresh
  // scaffold's HEAD is unborn, so `git show` fails and healing proceeds.
  try {
    const committed = runGit(appDir, ['show', 'HEAD:./wrangler.toml'], { allowFail: true })
    if (committed.status === 0 && committed.stdout.toString('utf-8').includes('__APP_ID__')) {
      return false
    }
  } catch {
    // No git — nothing committed to contradict the local file.
  }
  return true
}

/**
 * The id this checkout carries, minting one on first use when it has none.
 *
 * Returns null exactly when healing is not allowed here (see
 * {@link canHealAppRegistration}) — the caller throws its own precise
 * refusal. A malformed existing id never reaches the mint: `readAppId`
 * refuses it (`invalid_app_id`), so this can only ever fill a genuinely
 * absent or placeholder slot, never overwrite a value that might be a
 * corrupted real id.
 *
 * The announcement goes to STDERR, always: minting registers the app to
 * whoever is signed in, on whichever plane this shell selects — that must be
 * visible even under `--json`, whose stdout carries exactly one document.
 */
export async function ensureAppRegistered(
  appDir: string,
  token: string,
  wranglerEnv?: string,
  opts: { commitScaffold?: boolean } = {},
): Promise<{ appId: string; minted: boolean; committedScaffold: boolean } | null> {
  const existing = readAppId(appDir, wranglerEnv)
  if (existing) return { appId: existing, minted: false, committedScaffold: false }
  if (!canHealAppRegistration(appDir, wranglerEnv)) return null
  // One mint per checkout: two concurrent first-use commands (`dev` + `test`,
  // `deploy` + `secrets set`) would both see "no id", both register — one
  // registration orphaned, one quota slot burned. The loser waits for the
  // winner's wrangler.toml write instead.
  const release = acquireMintLock(appDir)
  if (!release) {
    const winner = await waitForMintedId(appDir, wranglerEnv)
    if (winner) return { appId: winner, minted: false, committedScaffold: false }
    // The lock holder died without writing; fall through and mint ourselves.
  }
  try {
    const raced = readAppId(appDir, wranglerEnv)
    if (raced) return { appId: raced, minted: false, committedScaffold: false }
    const { appId, committedScaffold } = await mintAppIdentity(appDir, token, {
      wranglerEnv,
      commitScaffold: opts.commitScaffold,
    })
    process.stderr.write(
      `Registered ${appId}${wranglerEnv ? ` (env: ${wranglerEnv})` : ''} on ${DEEPSPACE_ENV} to ` +
        `your account — apps register on first use` +
        (committedScaffold ? '; initial scaffold commit created' : '') +
        '.\n',
    )
    return { appId, minted: true, committedScaffold }
  } finally {
    release?.()
  }
}

/** mkdir-based mutual exclusion for the mint, scoped to one checkout. Returns
 *  a release fn, or null when another process holds it. Stale locks (an
 *  interrupted mint) expire by age so a crash cannot wedge registration. */
function acquireMintLock(appDir: string): (() => void) | null {
  const lockDir = join(appDir, '.deepspace', 'register.lock')
  mkdirSync(join(appDir, '.deepspace'), { recursive: true })
  try {
    mkdirSync(lockDir)
  } catch {
    try {
      const age = Date.now() - statSync(lockDir).mtimeMs
      if (age < 2 * 60 * 1000) return null
      // Older than any real mint (one POST + one file write): reclaim.
      rmSync(lockDir, { recursive: true, force: true })
      mkdirSync(lockDir)
    } catch {
      return null
    }
  }
  return () => rmSync(lockDir, { recursive: true, force: true })
}

/** Bounded wait for the lock holder's wrangler.toml write. */
async function waitForMintedId(appDir: string, wranglerEnv?: string): Promise<string | null> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const id = readAppId(appDir, wranglerEnv)
    if (id) return id
    if (!existsSync(join(appDir, '.deepspace', 'register.lock'))) {
      return readAppId(appDir, wranglerEnv)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return null
}

/** True exactly when the post-init `git commit … wrangler.toml` action would
 *  succeed. Asked of git itself via `--dry-run` rather than parsed out of
 *  porcelain codes: an untracked pathspec, a clean file, and a mid-merge
 *  partial commit (which git refuses even when wrangler.toml is not the
 *  conflicted file) all fail the dry run the same way they would fail the
 *  offered command, so the predicate cannot drift from git's behavior. */
export function wranglerConfigUncommitted(appDir: string): boolean {
  if (!existsSync(join(appDir, '.git'))) return false
  const dryRun = runGit(appDir, ['commit', '--dry-run', '-m', 'x', '--', 'wrangler.toml'], {
    allowFail: true,
  })
  return dryRun.status === 0
}

/**
 * Complete a scaffold that arrived with an UNBORN HEAD: the scaffolder
 * git-inits the repo but the initial commit waits for the app's identity, so
 * it happens here, with the id in place. Commits only in that exact state —
 * a repo with any history is the user's to commit.
 */
export function commitScaffoldIfUnborn(appDir: string, token: string): boolean {
  try {
    if (!existsSync(join(appDir, '.git'))) return false
    if (runGit(appDir, ['rev-parse', '--verify', 'HEAD'], { allowFail: true }).status === 0) {
      return false
    }
    // The one PRE-REMOTE identity write in the CLI: this runs before any
    // `space` remote exists. Every remote-bound verb gets its identity
    // through `ensureSpaceRemote`, which folds this in.
    ensureGitIdentity(appDir, token)
    if (runGit(appDir, ['add', '-A'], { allowFail: true }).status !== 0) return false
    const commit = runGit(appDir, ['commit', '-m', 'Initial DeepSpace scaffold', '--no-verify'], {
      allowFail: true,
    })
    return commit.status === 0
  } catch {
    // No git on PATH (or an unreadable repo): identity is registered either
    // way; the commit is a convenience, never a failure of registration.
    return false
  }
}
