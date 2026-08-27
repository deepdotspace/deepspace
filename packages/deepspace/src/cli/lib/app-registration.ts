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
import { decodeJwtPayload } from '../../shared/jwt'
import { apiFetch } from './api'
import { APP_ID_PLACEHOLDER, readAppId, writeAppId } from './app-identity'
import { runGit } from './git/process'
import { ensureGitIdentity } from './vc-remote'
import { parse as parseToml } from 'smol-toml'
import {
  hasWranglerConfig,
  readAppIdVar,
  readWranglerConfig,
  type WranglerConfig,
} from './wrangler-env'

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
  return healBlocker(appDir, wranglerEnv) === null
}

/** Why an absent id here can NOT be healed by minting — or null when it can.
 *  One diagnosis point, so every verb's refusal can say the true reason
 *  instead of guessing (the GitHub-lane AX pass hit "this does not look like
 *  a DeepSpace app" on a scaffold whose only sin was a COMMITTED
 *  placeholder). */
export function healBlocker(
  appDir: string,
  wranglerEnv?: string,
): 'no_config' | 'env_undeclared' | 'id_undeclared' | 'placeholder_committed' | null {
  if (!hasWranglerConfig(appDir)) return 'no_config'
  try {
    const cfg = readWranglerConfig(appDir)
    if (wranglerEnv && cfg.env?.[wranglerEnv] === undefined) return 'env_undeclared'
    if (readAppIdVar(cfg, wranglerEnv) === undefined) return 'id_undeclared'
  } catch {
    // An unreadable wrangler.toml is its own failure; let readAppId report it.
    return 'id_undeclared'
  }
  // A placeholder COMMITTED to history is a shared-repo state, not a fresh
  // scaffold: every teammate's clone would silently mint its own app on
  // first use, none of them the app the repo is about. Refuse (the old
  // explicit-step behavior) — the repo's owner should register once and
  // commit the real id, or a deliberate fork uses `app init`. A fresh
  // scaffold's HEAD is unborn, so `git show` fails and healing proceeds.
  // NOTE the GitHub lane hits this on its FIRST deploy: pushing the scaffold
  // to GitHub commits the placeholder, so the refusal for this state must
  // name `app init` (which mints regardless) as the remedy, not imply the
  // directory isn't a DeepSpace app.
  //
  // Scoped to the TARGET SECTION, not the whole file: a checkout whose
  // top-level id is real but whose committed [env.staging.vars] still holds
  // the placeholder (the documented way to add an environment) must answer
  // for the section that was asked about — a whole-file grep dead-ended
  // `--env` deploys behind a shared-repo lecture whose remedy re-read the
  // top level and said "already initialized".
  try {
    const committed = runGit(appDir, ['show', 'HEAD:./wrangler.toml'], { allowFail: true })
    if (committed.status === 0) {
      const committedCfg = parseToml(committed.stdout.toString('utf-8')) as WranglerConfig
      if (readAppIdVar(committedCfg, wranglerEnv) === APP_ID_PLACEHOLDER) {
        return 'placeholder_committed'
      }
    }
  } catch {
    // No git, or unparseable committed content — nothing committed to
    // contradict the local file.
  }
  return null
}

/** The refusal for a verb that wanted to register on first use and could not
 *  — one builder, so deploy and the resolver agree and each blocked state
 *  gets its true diagnosis and remedy. */
export function healRefusal(
  appDir: string,
  wranglerEnv: string | undefined,
): { message: string; code: string; action?: { cwd: string; argv: string[] } } {
  const blocker = healBlocker(appDir, wranglerEnv)
  if (blocker === 'placeholder_committed') {
    const section = wranglerEnv ? `[env.${wranglerEnv}.vars]` : 'wrangler.toml'
    const initArgv = ['deepspace', 'app', 'init', ...(wranglerEnv ? ['--env', wranglerEnv] : [])]
    return {
      message:
        `${section} still carries the scaffold's \`__APP_ID__\` placeholder in COMMITTED history, ` +
        `so first use will not mint here — in a shared repo every clone would silently register its own app. ` +
        `Run \`${initArgv.join(' ')}\` once to register it, then commit the real id so ` +
        `collaborators share it (a deliberate fork of someone else's repo uses \`app init --new-id\`).`,
      code: 'placeholder_committed',
      action: { cwd: appDir, argv: initArgv },
    }
  }
  if (wranglerEnv) {
    return {
      message:
        `No app id for [env.${wranglerEnv}] — declare the [env.${wranglerEnv}] block with its own ` +
        `DEEPSPACE_APP_ID entry (the \`__APP_ID__\` placeholder is enough), or run ` +
        `\`deepspace app init --env ${wranglerEnv}\`.`,
      code: 'no_app_id_for_env',
    }
  }
  return {
    message:
      'wrangler.toml declares no DEEPSPACE_APP_ID — this does not look like a DeepSpace app. ' +
      'Run `deepspace app init` to register it as one.',
    code: 'app_not_initialized',
    action: { cwd: appDir, argv: ['deepspace', 'app', 'init'] },
  }
}

/** The registering account, named: registration spends that account's quota
 *  slot, and on a machine with two logins the hazard the announcement exists
 *  to catch — registering under the wrong one — is invisible without the
 *  email (v0.26.0 AX, both host lanes). Falls back to the generic phrase for
 *  an undecodable token. One helper so `app init` and the first-use resolver
 *  announce identically. */
export function accountLabel(token: string): string {
  try {
    return decodeJwtPayload<{ email?: string }>(token).email ?? 'your account'
  } catch {
    return 'your account'
  }
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
        `${accountLabel(token)} — apps register on first use` +
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
