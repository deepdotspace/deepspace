/**
 * Git push protocol for the `space` remote: porcelain parsing, retryable
 * transport classification, and actionable rejection messages. Remote URL,
 * credential-helper, and auth configuration remain in `vc-remote.ts`.
 */

import { formatBytes } from '../../shared/app-files'
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
  code: 'app_quota_exceeded' | 'source_managed_by_github' | 'rate_limited' | 'push_too_large'
  error: string
}

/**
 * Classify HTTP failures whose bodies Git's smart-HTTP transport discards.
 *
 * Only the status survives — git prints `RPC failed; HTTP 413` and drops the
 * server's sentence — so each branch reconstructs the advice client-side.
 * `cwd` is optional and only used to name the offending objects on a 413; the
 * classification never depends on it.
 */
export function classifyPushTransportFailure(
  error: unknown,
  cwd?: string,
): PushTransportFailure | null {
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
  if (/(?:HTTP |error: )413\b/i.test(message)) {
    return { code: 'push_too_large', error: pushTooLargeMessage(cwd) }
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

/** Mirrors deploy-worker's MAX_PACK_BYTES — one push's compressed pack. */
const SERVER_PACK_CAP_BYTES = 32 * 1024 * 1024

/** The ceilings, for `--help` — discoverable before a push hits them. */
export const PUSH_CEILINGS = `${formatBytes(SERVER_OBJECT_CAP_BYTES)} per file, ${formatBytes(SERVER_PACK_CAP_BYTES)} per push`

/** How to locate the offending object when the repo isn't at hand. */
export const OVERSIZED_PUSH_FIX =
  `Find the offending object with ` +
  `\`git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)' | sort -k2 -n | tail\`.`

/**
 * The correction, as an executable sequence. Every clause here has been run
 * against the real rejection, because each previous version of this text was
 * wrong in a way that only running it revealed:
 *
 *   - "`git rm --cached` + re-commit" leaves the blob reachable from the
 *     earlier commit, so the next push sends the identical bytes.
 *   - "`git reset --soft <commit>` and re-commit without the file" leaves the
 *     file STAGED — reset --soft moves HEAD only — so the re-commit re-adds it
 *     and the push is refused identically. `git restore --staged` is the step
 *     that makes the outcome deterministic rather than dependent on whether
 *     the file happened to be unstaged already.
 *   - "commit, then push" is wrong when the dropped commit held ONLY the file:
 *     the index then matches HEAD, `git commit` exits 1 "nothing to commit",
 *     and `git push` says "Everything up-to-date" — which IS the goal (there
 *     is nothing left carrying the blob) but reads as two failures in a row.
 *     Both outcomes are named so neither looks like the recipe went wrong.
 *   - `.gitignore` governs Git, not the deploy bundle: anything under
 *     `public/` still ships as a release asset, so the file has to MOVE.
 *
 * `deepspace app files put` is named first because it is the destination that
 * makes the rest a one-way trip instead of a loop.
 */
function removeFromHistoryAdvice(path: string | null): string {
  const file = path ? shQuote(path) : '<file>'
  return (
    `Media belongs in the app's files rather than Git history — \`deepspace app files put ${file}\` ` +
    `stores it in the app's own allocation and serves it over HTTP. Then get it out of both the ` +
    `push and the bundle, in this order: (1) move it OUT of \`public/\` — .gitignore keeps it out ` +
    `of Git but not out of the deploy bundle, which uploads every file under \`public/\`; ` +
    `(2) if the commits that carry it are still local, \`git reset --soft <last pushed commit>\`, ` +
    `then \`git restore --staged ${file}\` — reset --soft moves HEAD only and leaves the file ` +
    `staged, so skipping this step re-commits the same blob; (3) commit what remains, then push — ` +
    `if git says "nothing to commit", that commit held only the file, so skip straight to the ` +
    `push and "Everything up-to-date" means you are done. If it already reached pushed history, ` +
    `rewrite it out instead (\`git filter-repo --path ${file} --invert-paths\`).`
  )
}

type OversizedObject = { path: string; bytes: number }

/** Render the correction for an ALREADY-SCANNED object list. Scanning the
 *  object database walks every object in the repo, so callers that need both
 *  the list and this sentence scan once and pass it here. */
function fixForObjects(objects: OversizedObject[]): string {
  if (objects.length === 0) return `${OVERSIZED_PUSH_FIX} ${removeFromHistoryAdvice(null)}`
  const one = objects.length === 1
  const named = objects.map((object) => `${object.path} (${formatBytes(object.bytes)})`).join(', ')
  return (
    `The oversized ${one ? 'file is' : 'files are'} ${named}. ` +
    `${removeFromHistoryAdvice(one ? objects[0].path : null)}`
  )
}

/** Name over-cap objects when possible so the correction is mechanical. */
export function oversizedPushFix(cwd?: string, cap: number = SERVER_OBJECT_CAP_BYTES): string {
  return fixForObjects(cwd ? findOversizedObjects(cwd, cap) : [])
}

/**
 * The advice for an HTTP 413 — the transport-level "this push is too big".
 *
 * Git discards the server's response body here, so the ceilings are restated
 * client-side. Both are named because the status alone cannot say which one
 * was hit: the pack cap bounds ONE push, the object cap bounds ONE file. When
 * the repo is at hand, the over-cap blobs are named outright, which usually
 * identifies the cause without the caller running anything.
 *
 * The remedy is deliberately not "split the push" for media. Binary files
 * never delta well, so every clone of the app pays for them forever — that is
 * exactly what these ceilings exist to prevent. Media belongs in the app's
 * files allocation, which serves it over HTTP and keeps it out of history.
 */
export function pushTooLargeMessage(cwd?: string): string {
  const ceilings =
    `The cloud repo refused this push as too large (HTTP 413). The ceilings are ` +
    `${formatBytes(SERVER_OBJECT_CAP_BYTES)} per file and ` +
    `${formatBytes(SERVER_PACK_CAP_BYTES)} of compressed history per push. ` +
    `Large media never compresses, so every clone would pay for it forever.`
  const objects = cwd ? findOversizedObjects(cwd, SERVER_OBJECT_CAP_BYTES) : []
  if (objects.length === 0) {
    // Nothing over the per-file cap, so the pack cap is what was hit: the
    // history is simply too big for one push, which splitting does fix.
    return (
      `${ceilings} No single file is over the per-file cap, so this is the volume of history — ` +
      `push it in smaller batches (\`git push space <earlier-commit>:refs/heads/<branch>\` first, ` +
      `then the rest). ${OVERSIZED_PUSH_FIX}`
    )
  }
  return `${ceilings} ${fixForObjects(objects)}`
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
