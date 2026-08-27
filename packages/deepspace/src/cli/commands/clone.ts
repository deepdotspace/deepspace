/**
 * `deepspace clone <app> [dir]` — materialize an app's cloud repo locally.
 *
 * The collaborator on-ramp with no GitHub in the loop: resolve the app (id
 * or subdomain name), then let REAL git clone the platform's smart-HTTP
 * remote — full history, all branches, default branch checked out. The
 * remote comes out named `space` and the credential helper is configured,
 * so plain `git push space` / `git fetch space` work from here on. The
 * clone is deploy-ready because identity travels in the repo itself
 * (wrangler.toml carries DEEPSPACE_APP_ID); secrets come separately via
 * `deepspace secrets pull`.
 *
 * Defined with the command runtime (lib/command.ts): `--json`, the envelope,
 * the slug, and the exit codes come from there, not from this file.
 */

import * as p from '@clack/prompts'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { resolve, basename, join } from 'node:path'
import { ensureToken } from '../auth'
import { resolveAppSelector, assertAppTargetResolvable } from '../lib/app-target'
import { currentBranch, resolveCommit } from '../lib/git/repository'
import { githubInferredRefusal, inferredGitHubRepository } from '../lib/source-api'
import {
  deployBaseUrl,
  ensureSpaceRemote,
  repoUrl,
  runGitRemote,
  SPACE_REMOTE,
} from '../lib/vc-remote'
import { repoApi } from '../lib/repo-api'
import { createSpinner } from '../lib/spinner'
import { defineDeepspaceCommand, Refusal } from '../lib/command'
import { detectPackageManager } from '../lib/package-manager'

/**
 * Tidy a PRE-EXISTING target dir after a failed clone. git removes a clone
 * target it CREATED, but a dir that already existed keeps whatever partial
 * content the failure left. The caller verified the dir was empty right
 * before cloning, so a leftover that is ONLY `.git` is unambiguously the
 * failed transfer's debris — remove it. Anything else (a partial checkout, a
 * concurrent writer) is left alone: never delete content we didn't watch git
 * create. Returns what remains (empty when the dir is clean again). Pure fs
 * + exported for tests.
 */
export function cleanFailedCloneDir(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return existsSync(dir) ? ['<unreadable>'] : []
  }
  if (entries.length === 1 && entries[0] === '.git') {
    try {
      rmSync(join(dir, '.git'), { recursive: true, force: true })
      return []
    } catch {
      return entries
    }
  }
  return entries
}

/** Validate the target before authentication or network work. */
export function validateCloneTarget(dir: string): boolean {
  if (!existsSync(dir)) return false
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      throw new Refusal(`${dir} already exists and is not a directory.`, 'dir_exists')
    }
    throw new Refusal(`${dir} already exists but could not be read.`, 'dir_unreadable')
  }
  if (entries.length > 0) {
    throw new Refusal(`${dir} already exists and is not empty.`, 'dir_exists')
  }
  return true
}

export default defineDeepspaceCommand({
  meta: {
    name: 'clone',
    description: "Clone an app's cloud repo into a new directory",
  },
  args: {
    app: {
      type: 'positional',
      description: 'App id (app_…) or subdomain name',
      required: true,
    },
    dir: {
      type: 'positional',
      description: 'Target directory (default: the app name you passed)',
      required: false,
    },
  },
  async run({ args }) {
    // A blank app selector is a client-side error — reject it BEFORE the token
    // read so it never surfaces as not_authenticated.
    assertAppTargetResolvable(String(args.app))
    const selector = String(args.app).trim()
    const dir = resolve(String(args.dir ?? selector))
    // Whether the target existed before the clone: git only removes a
    // failed clone's dir when IT created the dir, so a pre-existing (empty)
    // one is ours to tidy on failure.
    const dirPreexisted = validateCloneTarget(dir)

    const spinner = args.json ? null : createSpinner()
    spinner?.start(`Resolving ${selector}…`)
    const token = await ensureToken()
    const deployUrl = deployBaseUrl()
    const appId = await resolveAppSelector(deployUrl, token, selector)

    // Probe the JSON refs first: cloning an unregistered/empty repo would
    // "succeed" as an empty checkout — an actionable message beats that.
    spinner?.message(`Checking ${selector}'s cloud repo…`)
    const remote = await repoApi(deployUrl, token, appId).getRefs()
    const branches = (remote?.refs ?? []).filter((r) => r.name.startsWith('refs/heads/'))
    if (!remote || branches.length === 0) {
      spinner?.stop('Nothing to clone.')
      // An empty cloud repo has two very different meanings: a DeepSpace app
      // nobody pushed yet, or a GitHub-inferred app whose emptiness is the
      // design. Telling the second kind to `deepspace push` steers them
      // through the permanent claim (v0.26.0 AX finding), so consult the
      // release ledger before prescribing it.
      const githubRepo = await inferredGitHubRepository(deployUrl, token, appId)
      if (githubRepo) throw githubInferredRefusal(appId, githubRepo)
      throw new Refusal(
        `${selector} has no cloud repo history yet. Its owner (or their agent) needs to run \`deepspace push\` from the app's repo first.`,
        'no_cloud_repo',
      )
    }

    // Real git does the transfer; auth rides in env, never argv.
    spinner?.message(`Cloning ${selector}…`)
    try {
      runGitRemote(process.cwd(), token, [
        'clone',
        '--quiet',
        '--origin',
        SPACE_REMOTE,
        repoUrl(appId),
        dir,
      ])
    } catch (err) {
      // A failed clone into a dir the user pre-created leaves the partial
      // transfer behind (git only cleans dirs it made). Reap the
      // unambiguous debris; report anything left.
      if (dirPreexisted) {
        const leftovers = cleanFailedCloneDir(dir)
        if (leftovers.length > 0 && !args.json) {
          process.stderr.write(
            `note: the failed clone left files in ${dir}: ${leftovers.join(', ')}\n`,
          )
        }
      }
      // Rethrown as-is: the runtime keeps the machine code (a GitError slug,
      // not_authenticated, an ApiError slug) so a --json caller can branch on it.
      throw err
    }
    // The remote URL is already right — this installs the credential
    // helper so bare git works in this clone from now on, and gives the fresh
    // checkout an identity so its first commit or merge isn't blocked on
    // global git config the machine may not have.
    ensureSpaceRemote(dir, appId, undefined, token)

    const head = resolveCommit(dir, 'HEAD')
    const branch = currentBranch(dir)
    spinner?.stop(
      `Cloned ${selector} (${branches.length} ${branches.length === 1 ? 'branch' : 'branches'}) into ${basename(dir)}/ at ${head?.slice(0, 10) ?? '(unborn)'}.`,
    )

    if (!args.json && !branch) {
      p.log.warn('HEAD is detached — check `git branch -a`.')
    }
    return {
      data: {
        appId,
        dir,
        head,
        branch,
        remoteBranches: branches.map((r) => r.name.replace(/^refs\/heads\//, '')),
      },
      // One runnable follow-up instead of the old five-line "Next steps" block:
      // nothing else in the clone works until the deps are installed. Secrets
      // (`deepspace secrets pull`) and `dev` follow from there.
      action: { cwd: dir, argv: [detectPackageManager(dir), 'install'] },
    }
  },
})
