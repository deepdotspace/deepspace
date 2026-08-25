/**
 * Remote URL, bearer auth, credential-helper setup, and session-derived Git
 * identity for the platform source remotes — the auth ↔ git-config bridge.
 * The transfer itself is real Git; push protocol parsing lives in `vc-push.ts`.
 */

import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { DEEPSPACE_ENV, PLATFORM_URLS, type DeepSpaceEnvironment } from '../env'
import { decodeJwtPayload } from '../../shared/jwt'
import { shQuote } from './cli-format'
import { runGit } from './git/process'
import { declaredAppIds } from './app-identity'
import { InputError } from './cli-errors'

/** Resolve the source remote without allowing staging to re-aim production state. */
export function spaceRemoteName(environment: DeepSpaceEnvironment = DEEPSPACE_ENV): string {
  if (environment === 'staging') return 'space-staging'
  if (environment === 'production') return 'space'
  return 'space-invalid'
}

/** The source remote for this CLI process. */
export const SPACE_REMOTE = spaceRemoteName()

/** The environment-private tracking ref corresponding to a cloud branch. */
export function spaceTrackingRef(branch: string, remote = SPACE_REMOTE): string {
  return `refs/remotes/${remote}/${branch}`
}

/** Keep client-only source bookkeeping separate between production and staging. */
export function spacePrivateRef(
  path: string,
  environment: DeepSpaceEnvironment = DEEPSPACE_ENV,
): string {
  const root = environment === 'production'
    ? 'refs/deepspace'
    : `refs/deepspace/${environment}`
  return `${root}/${path}`
}

/** The deploy worker base URL, honoring the per-command override convention. */
export function deployBaseUrl(): string {
  return process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy
}

/** The app's smart-HTTP remote URL — clonable/pushable by real Git. */
export function repoUrl(appId: string, base: string = deployBaseUrl()): string {
  return `${base.replace(/\/+$/, '')}/api/repo/${encodeURIComponent(appId)}`
}

/**
 * Auth env for CLI-driven Git invocations. The bearer header is scoped to the
 * platform base URL and travels only in the child environment, never argv or
 * disk. Existing `GIT_CONFIG_*` entries are preserved.
 */
export function gitAuthEnv(token: string, base: string = deployBaseUrl()): Record<string, string> {
  const existing = Number(process.env.GIT_CONFIG_COUNT ?? '0')
  const index = Number.isInteger(existing) && existing > 0 ? existing : 0
  return {
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: `http.${base.replace(/\/+$/, '')}.extraHeader`,
    [`GIT_CONFIG_VALUE_${index}`]: `Authorization: Bearer ${token}`,
  }
}

/** Auth plus a source revision header for an owner preparing an inactive
 * DeepSpace destination while GitHub remains authoritative. */
export function gitSourceImportEnv(
  token: string,
  revision: number,
  base: string = deployBaseUrl(),
): Record<string, string> {
  const env = gitAuthEnv(token, base)
  const index = Number(env.GIT_CONFIG_COUNT)
  return {
    ...env,
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: `http.${base.replace(/\/+$/, '')}.extraHeader`,
    [`GIT_CONFIG_VALUE_${index}`]: `X-DeepSpace-Source-Revision: ${revision}`,
  }
}

/** Run Git with bearer-auth configuration injected via its environment. */
export function runGitRemote(
  cwd: string,
  token: string,
  args: string[],
  opts: { input?: string | Buffer; allowFail?: boolean; env?: Record<string, string> } = {},
): { stdout: Buffer; stderr: Buffer; status: number } {
  return runGit(cwd, args, { ...opts, env: { ...gitAuthEnv(token), ...(opts.env ?? {}) } })
}

/**
 * Whether the running CLI entry is ephemeral. A credential helper pinned into
 * global Git config must not point at an npm cache or app-local install that
 * can disappear.
 */
function entryIsTransient(cwd: string): boolean {
  const entry = process.argv[1]
  if (!entry) return true
  if (/[\\/]_npx[\\/]/.test(entry) || entry.startsWith(tmpdir())) return true
  const rel = relative(resolve(cwd), resolve(entry))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Does an existing pinned helper entry still point at usable files? */
function helperEntryUsable(command: string): boolean {
  // Quoted paths containing a single quote deliberately fall through to false;
  // re-aiming that rare form is simpler and safer than partially parsing shell.
  const match = /^!(?:DEEPSPACE_ENV=(production|staging) )?'([^']*)' '([^']*)' git-credential$/.exec(command)
  const expectedEnvironment = DEEPSPACE_ENV === 'production' ? undefined : DEEPSPACE_ENV
  if (!match || match[1] !== expectedEnvironment) return false
  return existsSync(match[2]) && existsSync(match[3])
}

/**
 * Pin the exact node binary and CLI entry, avoiding PATH and stale global CLI
 * shadowing. `shQuote` neutralizes every shell metacharacter in those paths.
 */
export function credentialHelperCommand(environment: DeepSpaceEnvironment = DEEPSPACE_ENV): string {
  const entry = process.argv[1]
  if (!entry) throw new Error('CLI entry path is unavailable')
  const environmentPrefix = environment === 'staging' ? 'DEEPSPACE_ENV=staging ' : ''
  return `!${environmentPrefix}${shQuote(process.execPath)} ${shQuote(entry)} git-credential`
}

/**
 * Best-effort host-scoped credential-helper installation. Wrapped commands
 * inject auth themselves; this setup exists so plain `git push space` and
 * `git clone <app-url>` work afterward.
 */
function installCredentialHelper(cwd: string, url: string): void {
  try {
    const origin = new URL(url)
    const key = `credential.${origin.protocol}//${origin.host}.helper`
    const helper = credentialHelperCommand()
    // The empty first value resets inherited helpers. Otherwise Git's approve
    // step could persist the short-lived DeepSpace bearer in an OS keychain.
    const wanted = ['', helper]
    const transient = entryIsTransient(cwd)
    const scope = transient ? '--worktree' : '--global'
    if (transient) {
      // Repository-local config is shared by every linked worktree. Never pin
      // an ephemeral Codex/Claude/app-local CLI path there: deleting that
      // checkout would break plain Git in all siblings. Git's worktree config
      // keeps the helper beside the checkout whose executable it references.
      const enabled = runGit(cwd, ['config', '--local', 'extensions.worktreeConfig', 'true'], {
        allowFail: true,
      })
      if (enabled.status !== 0) return
      runGit(cwd, ['config', '--local', '--unset-all', key], { allowFail: true })
    }
    const current = runGit(cwd, ['config', scope, '--get-all', key], { allowFail: true })
    if (current.status === 0) {
      const existing = current.stdout
        .toString('utf-8')
        .split('\n')
        .filter((_, index, lines) => index < lines.length - 1)
      if (existing.length === wanted.length && existing.every((value, i) => value === wanted[i])) {
        return
      }
      // Leave another usable checkout's helper alone so parallel checkouts do
      // not ping-pong global config. Rewrite only malformed or stale entries.
      if (
        existing.length === wanted.length &&
        existing[0] === '' &&
        helperEntryUsable(existing[1])
      ) {
        return
      }
      runGit(cwd, ['config', scope, '--unset-all', key], { allowFail: true })
    }
    runGit(cwd, ['config', scope, '--add', key, ''])
    runGit(cwd, ['config', scope, '--add', key, helper])
    if (scope === '--global' && !process.argv.includes('--json')) {
      process.stderr.write(
        `note: added a git credential helper for ${origin.host} to your global git config so ` +
          `plain \`git clone\`/\`git push\` to DeepSpace authenticate. ` +
          `Undo with: git config --global --unset-all ${key}\n`,
      )
    }
  } catch {
    // Best effort: wrapped transfers remain authenticated without the helper.
  }
}

/**
 * Point one platform source remote at this app, install its host-scoped
 * credential helper, and — when the caller hands over its session token —
 * fill in the checkout's git identity.
 *
 * `token` is what marks a verb that will go on to COMMIT (or hand back a
 * committing recovery): those are the only ones allowed to write
 * `.git/config`, and every one of them already resolves a token before it gets
 * here. Read-only verbs pass none and nothing is written. Folding the identity
 * step in is what makes it a chokepoint — as a separate call it was an
 * adjacent line each caller had to remember.
 */
export function ensureSpaceRemote(
  cwd: string,
  appId: string,
  remote = SPACE_REMOTE,
  token?: string,
): string {
  const url = repoUrl(appId)
  const current = runGit(cwd, ['remote', 'get-url', remote], { allowFail: true })
  const existing = current.status === 0 ? current.stdout.toString('utf-8').trim() : null
  // The invariant is RE-AIMING: never point an existing remote at a different
  // app than it already serves, or a later plain `git push` publishes this
  // app's source into another's repo, exit 0. So the checkout's declared ids
  // are consulted only when the remote is actually moving — a clone whose
  // committed wrangler.toml still names the app it was forked from is ordinary,
  // and a checkout declaring nothing proves nothing.
  if (appIdFromRepoUrl(existing ?? '') !== appId) {
    const owned = declaredAppIds(cwd)
    if (owned.size > 0 && !owned.has(appId)) {
      throw new InputError(
        `This checkout declares ${[...owned].join(', ')}, but this command targets ${appId}. ` +
          `Pointing its \`${remote}\` remote at another app would send every later plain ` +
          `\`git push ${remote}\` to the wrong repo. Work on ${appId} from its own checkout ` +
          `(\`deepspace clone ${appId}\` into a new directory), or fork THIS checkout into a ` +
          `brand-new app of your own with \`deepspace app init --new-id\`.`,
        'app_checkout_mismatch',
      )
    }
  }
  // After the guard: a refused command must not have written to the user's
  // `.git/config` on its way out.
  if (token) ensureGitIdentity(cwd, token)
  if (existing === null) {
    runGit(cwd, ['remote', 'add', remote, url])
  } else if (existing !== url) {
    const priorApp = appIdFromRepoUrl(existing)
    if (priorApp && priorApp !== appId && !process.argv.includes('--json')) {
      process.stderr.write(
        `warning: remote '${remote}' was pointed at app ${priorApp}; re-aiming it at ${appId}.\n`,
      )
    }
    runGit(cwd, ['remote', 'set-url', remote, url])
  }
  installCredentialHelper(cwd, url)
  return url
}

/**
 * Drop the platform source remote if the checkout has one — `ensureSpaceRemote`'s
 * counterpart, for when source authority LEAVES DeepSpace. A remote written
 * while DeepSpace owned source survives the flip, and a plain `git push space`
 * through it walks around `deepspace push`'s preflight straight into the deploy
 * worker's bodiless 422. Returns whether a remote was actually removed.
 */
export function removeSpaceRemote(cwd: string, remote = SPACE_REMOTE): boolean {
  const current = runGit(cwd, ['remote', 'get-url', remote], { allowFail: true })
  if (current.status !== 0) return false
  // Once presence is established, a failed removal is a failed source
  // reconciliation — never collapse it into the successful "absent" state.
  runGit(cwd, ['remote', 'remove', remote])
  return true
}

/**
 * Fill in whichever half of the checkout's Git identity is missing, from the
 * caller's session token. A checkout on a machine with no global identity —
 * or a half-configured one (a global user.name and no email dies on the same
 * "unable to auto-detect email address") — cannot commit or merge, including
 * the `git pull` a divergence refusal hands back as its recovery.
 *
 * Called from `ensureSpaceRemote` — which passes the token exactly for the
 * verbs that go on to commit — and once pre-remote from `init`, for the
 * scaffold's first commit. `--local` scope — shared by every linked
 * worktree of the checkout, which is what land-from-a-worktree needs — and per
 * key, so anything the user set is never overwritten.
 *
 * `user.useConfigOnly=true` is respected: that flag means "never guess my
 * identity", and guessing anyway — silently, in a repo the user deliberately
 * left unconfigured — is precisely what it exists to prevent.
 */
export function ensureGitIdentity(cwd: string, token: string): void {
  try {
    const configured = (key: string): boolean =>
      runGit(cwd, ['config', '--get', key], { allowFail: true }).stdout.toString('utf-8').trim() !==
      ''
    const missingName = !configured('user.name')
    const missingEmail = !configured('user.email')
    if (!missingName && !missingEmail) return
    // `--type=bool` because git accepts true|yes|on|1 and a bare key; a
    // literal string compare would honor only `= true` and quietly overwrite
    // every other spelling of the same intent.
    if (
      runGit(cwd, ['config', '--get', '--type=bool', 'user.useConfigOnly'], { allowFail: true })
        .stdout.toString('utf-8')
        .trim() === 'true'
    ) {
      return
    }
    const payload = decodeJwtPayload<{ email?: string; name?: string }>(token)
    if (!payload.email) return
    if (missingName) {
      runGit(cwd, ['config', '--local', 'user.name', payload.name || payload.email], {
        allowFail: true,
      })
    }
    if (missingEmail) {
      runGit(cwd, ['config', '--local', 'user.email', payload.email], { allowFail: true })
    }
    // Say it out loud, with the undo — this writes to a file the user owns.
    // To STDERR, always: `--json` promises exactly one document on stdout, and
    // a chatty repair on the commonest bootstrap path (the first `--json` call
    // in a fresh clone) makes that document unparseable. The undo names only
    // the keys THIS call wrote (a hand-set user.name must survive the paste),
    // and quotes the path so it survives a checkout with spaces in it.
    const wrote = [...(missingEmail ? ['user.email'] : []), ...(missingName ? ['user.name'] : [])]
    const dir = /^[A-Za-z0-9_./:@-]+$/.test(cwd) ? cwd : shQuote(cwd)
    const undo = wrote.map((key) => `git -C ${dir} config --local --unset ${key}`).join(' && ')
    process.stderr.write(
      `Git identity for this checkout set from your DeepSpace login (${payload.email}).\n` +
        `  Undo with: ${undo}\n`,
    )
  } catch {
    // Undecodable token, unreadable config, or a non-repo cwd — leave Git as it is.
  }
}

/** Extract the app id from a DeepSpace repository URL. */
function appIdFromRepoUrl(url: string): string | null {
  const match = /\/api\/repo\/([^/]+)\/?$/.exec(url)
  return match ? decodeURIComponent(match[1]) : null
}
