/**
 * Remote URL, bearer auth, and credential-helper setup for the `space` remote.
 * The transfer itself is real Git; push protocol parsing lives in `vc-push.ts`.
 */

import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { PLATFORM_URLS } from '../env'
import { shQuote } from './cli-format'
import { runGit } from './git/process'

/** The remote name the platform repo lives under in every synced clone. */
export const SPACE_REMOTE = 'space'

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
  const match = /^!'([^']*)' '([^']*)' git-credential$/.exec(command)
  return match !== null && existsSync(match[1]) && existsSync(match[2])
}

/**
 * Pin the exact node binary and CLI entry, avoiding PATH and stale global CLI
 * shadowing. `shQuote` neutralizes every shell metacharacter in those paths.
 */
export function credentialHelperCommand(): string {
  const entry = process.argv[1]
  if (!entry) throw new Error('CLI entry path is unavailable')
  return `!${shQuote(process.execPath)} ${shQuote(entry)} git-credential`
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

/** Point `space` at this app and install the host-scoped credential helper. */
export function ensureSpaceRemote(cwd: string, appId: string): string {
  const url = repoUrl(appId)
  const current = runGit(cwd, ['remote', 'get-url', SPACE_REMOTE], { allowFail: true })
  if (current.status !== 0) {
    runGit(cwd, ['remote', 'add', SPACE_REMOTE, url])
  } else {
    const existing = current.stdout.toString('utf-8').trim()
    if (existing !== url) {
      const priorApp = appIdFromRepoUrl(existing)
      if (priorApp && priorApp !== appId && !process.argv.includes('--json')) {
        process.stderr.write(
          `warning: remote '${SPACE_REMOTE}' was pointed at app ${priorApp}; re-aiming it at ${appId}.\n`,
        )
      }
      runGit(cwd, ['remote', 'set-url', SPACE_REMOTE, url])
    }
  }
  installCredentialHelper(cwd, url)
  return url
}

/** Extract the app id from a DeepSpace repository URL. */
function appIdFromRepoUrl(url: string): string | null {
  const match = /\/api\/repo\/([^/]+)\/?$/.exec(url)
  return match ? decodeURIComponent(match[1]) : null
}
