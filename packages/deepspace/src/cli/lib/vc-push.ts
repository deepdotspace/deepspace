/**
 * Git push protocol for the `space` remote: porcelain parsing, retryable
 * transport classification, and actionable rejection messages. Remote URL,
 * credential-helper, and auth configuration remain in `vc-remote.ts`.
 */

import { shQuote } from './cli-format'
import { GitError } from './git/process'
import { findOversizedObjects } from './git/safety'
import { runGitRemote, SPACE_REMOTE } from './vc-remote'

export type PushRefStatus =
  | 'committed'
  | 'up_to_date'
  | 'non_fast_forward'
  | 'ref_conflict'
  | 'rejected'

/**
 * The exact `ng` reasons emitted when the server's ref CAS loses a race. Other
 * server rejections are policy/data failures; `deepspace pull` cannot fix them.
 */
const CAS_CONFLICT_REASON = /stale ref|fetch first|no such ref|atomic push failed/i

export interface PushRefResult {
  status: PushRefStatus
  localRef: string
  remoteRef: string
  /** Raw summary column from `git push --porcelain`. */
  summary: string
  /** Parenthesized server/client rejection reason. */
  reason?: string
}

/** Parse `git push --porcelain` into one result per ref. */
export function parsePushPorcelain(out: string): PushRefResult[] {
  const results: PushRefResult[] = []
  for (const line of out.split('\n')) {
    const match = /^([ +\-*=!])\t([^\t]*)\t(.*)$/.exec(line)
    if (!match) continue
    const [, flag, refspec, summary] = match
    const colon = refspec.indexOf(':')
    const localRef = colon >= 0 ? refspec.slice(0, colon) : refspec
    const remoteRef = colon >= 0 ? refspec.slice(colon + 1) : refspec
    let status: PushRefStatus
    let reason: string | undefined
    if (flag === '=') {
      status = 'up_to_date'
    } else if (flag === '!') {
      reason = /\((.*)\)\s*$/.exec(summary)?.[1]
      if (!summary.startsWith('[remote rejected]')) {
        status = 'non_fast_forward'
      } else if (reason && CAS_CONFLICT_REASON.test(reason)) {
        status = 'ref_conflict'
      } else {
        status = 'rejected'
      }
    } else {
      status = 'committed'
    }
    results.push({ status, localRef, remoteRef, summary, ...(reason ? { reason } : {}) })
  }
  return results
}

/** The server explicitly asks for a full-pack retry on this one rejection. */
export function isThinPackRejection(result: PushRefResult): boolean {
  return (
    result.status === 'rejected' &&
    /thin (?:push|pack)|--no-thin/i.test(result.reason ?? result.summary ?? '')
  )
}

/** Whether pull is the one deterministic recovery for a failed push. */
export function isRecoverablePushFailure(status: PushRefStatus): boolean {
  return status === 'non_fast_forward' || status === 'ref_conflict'
}

export interface PushTransportFailure {
  code: 'app_quota_exceeded' | 'source_managed_by_github' | 'rate_limited'
  error: string
}

/** Classify HTTP failures whose bodies Git's smart-HTTP transport discards. */
export function classifyPushTransportFailure(error: unknown): PushTransportFailure | null {
  const message = error instanceof Error ? error.message : String(error)
  // Match only HTTP-status contexts: `Total 429 (delta 3)` is valid git output.
  if (/(?:HTTP |error: )409\b/i.test(message)) {
    return {
      code: 'app_quota_exceeded',
      error:
        `A first push to this new app hit your plan's active-app quota. ` +
        `Use \`deepspace app list\` to choose an app to undeploy, or upgrade your plan, then retry.`,
    }
  }
  if (/(?:HTTP |error: )422\b/i.test(message)) {
    return {
      code: 'source_managed_by_github',
      error:
        'This app uses GitHub source. Manage commits with normal Git/GitHub; `deepspace deploy` ships the local working tree without changing Git.',
    }
  }
  if (/(?:HTTP |error: )429\b/i.test(message)) {
    return {
      code: 'rate_limited',
      error: 'The cloud repo rate-limited this push. Wait a few seconds, then retry.',
    }
  }
  return null
}

/** Push one refspec and return Git's porcelain result. */
export function pushToSpace(
  cwd: string,
  token: string,
  refspec: string,
  opts: { force?: boolean; remote?: string } = {},
): PushRefResult {
  const doPush = (extra: string[]): PushRefResult => {
    const result = runGitRemote(
      cwd,
      token,
      ['push', '--porcelain', ...(opts.force ? ['--force'] : []), ...extra, opts.remote ?? SPACE_REMOTE, refspec],
      { allowFail: true },
    )
    const parsed = parsePushPorcelain(result.stdout.toString('utf-8'))
    if (parsed.length === 0) {
      const stderr = result.stderr.toString('utf-8').trim()
      throw new GitError(
        stderr || `git push exited ${result.status} without reporting a ref status`,
      )
    }
    return parsed[0]
  }
  const first = doPush([])
  return isThinPackRejection(first) ? doPush(['--no-thin']) : first
}

/** Matches the server's oversized-object rejection text. */
export const OVERSIZED_PUSH_RE = /too large|exceeds|\bLFS\b/i

/** Mirrors deploy-worker's per-object cap; the server remains the enforcer. */
const SERVER_OBJECT_CAP_BYTES = 20 * 1024 * 1024

export const OVERSIZED_PUSH_FIX =
  `Find the offending object with ` +
  `\`git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)' | sort -k2 -n | tail\`, ` +
  `then .gitignore it (or move it to Git LFS) and re-commit.`

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`
  return `${bytes} B`
}

/** Name over-cap objects when possible so the correction is mechanical. */
export function oversizedPushFix(cwd?: string, cap: number = SERVER_OBJECT_CAP_BYTES): string {
  const objects = cwd ? findOversizedObjects(cwd, cap) : []
  if (objects.length === 0) return OVERSIZED_PUSH_FIX
  const one = objects.length === 1
  const named = objects.map((object) => `${object.path} (${formatBytes(object.bytes)})`).join(', ')
  return (
    `The oversized ${one ? 'file is' : 'files are'} ${named}. ` +
    `Remove ${one ? 'it' : 'them'} from history (\`git rm --cached ${one ? shQuote(objects[0].path) : '<path>'}\`, ` +
    `add to .gitignore, re-commit) or track ${one ? 'it' : 'them'} with Git LFS.`
  )
}

/**
 * Render a non-divergence push rejection. Only the server's explicit
 * retry-the-push race is classified transient; unknown and policy rejections
 * fail closed so agents do not loop on a permanent refusal.
 */
export function pushFailureMessage(label: string, push: PushRefResult, cwd?: string): string {
  const reason = push.reason ?? push.summary ?? ''
  const detail = `${push.status}${reason ? `: ${reason}` : ''}`
  if (OVERSIZED_PUSH_RE.test(reason)) {
    return `${label} failed (${detail}) — an object exceeds the server's size cap, so retrying cannot succeed. ${oversizedPushFix(cwd)}`
  }
  if (/^missing necessary objects — retry the push$/i.test(reason)) {
    return `${label} failed (${detail}). Retry; if it persists, report it with \`deepspace feedback\`.`
  }
  return (
    `${label} failed (${detail}). The server rejected this push; correct the reported ` +
    `history/ref problem, or report it with \`deepspace feedback\` if the reason is unclear.`
  )
}
