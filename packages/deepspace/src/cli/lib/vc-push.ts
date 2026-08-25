/**
 * Git push protocol for the `space` remote: porcelain parsing, retryable
 * transport classification, and actionable rejection messages. Remote URL,
 * credential-helper, and auth configuration remain in `vc-remote.ts`.
 */

import { formatBytes } from '../../shared/app-files'
import { shQuote } from './cli-format'
import { GitError } from './git/process'
import {
  findOversizedObjects,
  secretRecoverySentence,
  SECRET_IN_HISTORY_CODE,
} from './git/safety'
import { runGitRemote, SPACE_REMOTE } from './vc-remote'

export type PushRefStatus =
  | 'committed'
  | 'up_to_date'
  | 'non_fast_forward'
  | 'ref_conflict'
  | 'rejected'

export interface PushRefResult {
  status: PushRefStatus
  localRef: string
  remoteRef: string
  /** Raw summary column from `git push --porcelain`. */
  summary: string
  /** Parenthesized server/client rejection reason, machine token included. */
  reason?: string
  /** The server's own refusal code, when the reason carried one. */
  code?: string
}

/**
 * A server refusal reason is `<code>: <sentence>[ — <detail>]`, with the code
 * matching `^[a-z_]+$` and minted from ONE table in the worker
 * (`vc/do/common.ts` `PUSH_REFUSAL`). The CLI reads the token and never the
 * prose.
 *
 * Anchored at position 0, which is the whole point: refusal sentences EMBED
 * pusher-chosen paths and ref names, and any classifier that looked inside the
 * sentence could be steered by a crafted filename. Nothing a pusher controls
 * reaches offset 0.
 *
 * `null` when the reason carries no token — an older worker, or a rejection
 * git itself wrote. Those stay unclassified rather than being guessed at.
 */
export function parseRefusalCode(
  reason: string,
): { code: string; sentence: string; detail?: string } | null {
  const match = /^([a-z_]+): (.*)$/s.exec(reason)
  if (!match) return null
  // Split on the FIRST ` — `: sentences contain that dash themselves
  // (`committed secret — remove it from history…`), and the grammar puts the
  // detail after the first one. The server's own tests hold that invariant.
  const remainder = match[2]
  const cut = remainder.indexOf(' — ')
  return cut === -1
    ? { code: match[1], sentence: remainder }
    : {
        code: match[1],
        sentence: remainder.slice(0, cut),
        detail: remainder.slice(cut + ' — '.length),
      }
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
    let code: string | undefined
    if (flag === '=') {
      status = 'up_to_date'
    } else if (flag === '!') {
      reason = /\((.*)\)\s*$/.exec(summary)?.[1]
      code = reason ? (parseRefusalCode(reason)?.code ?? undefined) : undefined
      if (!summary.startsWith('[remote rejected]')) {
        status = 'non_fast_forward'
      } else if (code === 'stale_ref') {
        // The server's ref CAS lost a race — `deepspace pull` is the one
        // deterministic recovery. Every other rejection is policy or data.
        status = 'ref_conflict'
      } else {
        status = 'rejected'
      }
    } else {
      status = 'committed'
    }
    results.push({
      status,
      localRef,
      remoteRef,
      summary,
      ...(reason ? { reason } : {}),
      ...(code ? { code } : {}),
    })
  }
  return results
}

/** The server could not resolve this push's thin REF_DELTA bases and asks for
 *  a full-pack retry. Keyed on the server's own token, so no filename in the
 *  reason can trigger a needless full re-upload. */
export function isThinPackRejection(result: PushRefResult): boolean {
  return result.status === 'rejected' && result.code === 'thin_pack'
}

/** Whether pull is the one deterministic recovery for a failed push. */
export function isRecoverablePushFailure(status: PushRefStatus): boolean {
  return status === 'non_fast_forward' || status === 'ref_conflict'
}

export interface PushTransportFailure {
  code:
    | 'app_quota_exceeded'
    | 'source_managed_by_github'
    | 'rate_limited'
    | 'push_too_large'
    | 'push_outcome_unknown'
    | 'not_authenticated'
    | 'forbidden'
  error: string
}

/**
 * The HTTP status GIT itself reported for the transport, or null.
 *
 * Read only from git's own lines. A `remote:` line is the SERVER's stdout
 * relayed verbatim — a pre-receive hook printing `error: 403 blocked by
 * policy` is prose, and coding it `forbidden` would tell a caller their
 * credentials are wrong about a push that authenticated fine and was refused
 * on content. The status is a fact about the transport, so only the transport
 * may state it.
 *
 * The `HTTP `/`error: ` prefix is still required: `Total 429 (delta 3)` is
 * ordinary git progress output.
 */
function gitHttpStatus(message: string): number | null {
  for (const line of message.split('\n')) {
    if (/^\s*remote:/i.test(line)) continue
    const match = /(?:HTTP |error: )(\d{3})\b/i.exec(line)
    if (match) return Number(match[1])
  }
  return null
}

/**
 * Classify HTTP failures whose bodies Git's smart-HTTP transport discards.
 *
 * Only the status survives — git prints `RPC failed; HTTP 413` and drops the
 * server's sentence — so each branch reconstructs the advice client-side.
 * `cwd` is optional and only used to name the offending objects on a 413; the
 * classification never depends on it.
 *
 * The server's 422 (`source_managed_by_github`) is normally decided BEFORE
 * git runs — `push` refuses from `getAppSource` in its preflight
 * (`commands/push.ts`, which can name the repository) and `deploy` skips the
 * cloud push entirely for GitHub source (`commands/deploy/repository.ts`).
 * The branch below is the last resort for the case the preflight cannot see
 * (an older platform whose `/source` reports no provider): it cannot name the
 * repository, only the state.
 */
export function classifyPushTransportFailure(
  error: unknown,
  cwd?: string,
): PushTransportFailure | null {
  const message = error instanceof Error ? error.message : String(error)
  const status = gitHttpStatus(message)
  if (status === 409) {
    return {
      code: 'app_quota_exceeded',
      error:
        `A first push to this new app hit your plan's active-app quota. ` +
        `Use \`deepspace app list\` to choose an app to undeploy, or upgrade your plan, then retry.`,
    }
  }
  if (status === 429) {
    return {
      code: 'rate_limited',
      error: 'The cloud repo rate-limited this push. Wait a few seconds, then retry.',
    }
  }
  if (status === 413) {
    return { code: 'push_too_large', error: pushTooLargeMessage(cwd) }
  }
  if (status === 422) {
    return {
      code: 'source_managed_by_github',
      error:
        'This app\'s source is managed by GitHub, so pushes to the DeepSpace repo are refused. ' +
        'Push to the GitHub repository instead — `deepspace app status` names it.',
    }
  }
  // Auth/permission verdicts, which git also reports as a disconnect. These
  // are DEFINITE "did not land" — and the status is the only diagnostic that
  // survives, because git drops the response body (the premise of this whole
  // function).
  if (status === 401) {
    return {
      code: 'not_authenticated',
      error:
        'The cloud repo rejected the push as unauthenticated — the session likely expired mid-push. Run `deepspace auth login`, then push again. Nothing was applied.',
    }
  }
  if (status === 403) {
    return {
      code: 'forbidden',
      error:
        'The cloud repo refused this push: you do not have write access to that app, or its id belongs to another account (`deepspace app init --new-id` mints your own). Nothing was applied.',
    }
  }
  // Gated on NO status having survived: git prints "unexpected disconnect" for
  // EVERY HTTP failure, and with a status one of the branches above already
  // holds the verdict. Without one the connection died mid-exchange, so whether
  // the server applied the push is genuinely unknown — and it may well have.
  // Read as a plain failure, an agent's next move is a compensating one
  // (`push --force`, a reset) against a trunk that already moved.
  if (
    status === null &&
    /unexpected disconnect|Empty reply from server|curl (?:18|52|56)/i.test(
      message,
    )
  ) {
    return {
      code: 'push_outcome_unknown',
      error:
        'The connection dropped while the push was in flight with no reply from the server, so whether the cloud repo applied it is unknown — it may have landed. Re-run this push before anything else: an already-applied push reports `up_to_date`. Do NOT force-push or reset until you have.',
    }
  }
  return null
}

/** Push one refspec and return Git's porcelain result. */
/**
 * The ref result that carries the real verdict.
 *
 * A push is ATOMIC: when one ref is refused the server marks its siblings
 * `not_attempted`, and those lines say nothing about why anything failed.
 * Taking the first line blindly would report a secret refusal as
 * "stale ref — fetch first" whenever the innocent ref happened to sort first,
 * sending someone to pull for a problem pulling cannot touch.
 */
export function representativeResult(results: PushRefResult[]): PushRefResult {
  // A REFUSED line only. A mixed report — one ref up to date, another refused
  // — would otherwise answer with the successful line and hide the refusal
  // completely: the push failed and the caller would be told nothing did.
  const refused = results.filter(
    (result) => result.status !== 'committed' && result.status !== 'up_to_date',
  )
  return refused.find((result) => result.code !== 'not_attempted') ?? refused[0] ?? results[0]
}

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
      [
        'push',
        '--porcelain',
        ...(opts.force ? ['--force'] : []),
        ...extra,
        opts.remote ?? SPACE_REMOTE,
        refspec,
      ],
      { allowFail: true },
    )
    const parsed = parsePushPorcelain(result.stdout.toString('utf-8'))
    if (parsed.length === 0) {
      const stderr = result.stderr.toString('utf-8').trim()
      throw new GitError(
        stderr || `git push exited ${result.status} without reporting a ref status`,
      )
    }
    return representativeResult(parsed)
  }
  const first = doPush([])
  // The server asks for a full pack when it cannot resolve this push's thin
  // REF_DELTA bases; `--no-thin` sends whole objects instead.
  return isThinPackRejection(first) ? doPush(['--no-thin']) : first
}

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

export interface RejectionVerdict {
  /** The CLI slug an agent branches on. */
  code: string
  /** Advice, as a standalone sentence. */
  message: string
}

/** The catch-all: an untagged reason, or a code this CLI cannot explain. */
const GENERIC_REJECTION: RejectionVerdict = {
  code: 'rejected',
  message:
    `The server rejected this push; correct the reported history/ref problem, or report ` +
    `it with \`deepspace feedback\` if the reason is unclear.`,
}

/**
 * Advice per server refusal code. The `code` field is the PUBLIC CLI slug:
 * where a condition already had one it keeps it (`push_too_large`,
 * `repo_full`, `secret_in_history`), and otherwise the server's own token is
 * surfaced unchanged rather than flattened into the catch-all.
 */
const REFUSAL_ADVICE: Record<
  string,
  (ctx: { detail?: string; cwd?: string }) => RejectionVerdict
> = {
  push_too_large: ({ cwd }) => ({
    code: 'push_too_large',
    message: `An object exceeds the server's size cap, so retrying cannot succeed. ${oversizedPushFix(cwd)}`,
  }),
  repo_full: () => ({
    code: 'repo_full',
    message:
      `The cloud repo is at its size ceiling, so retrying cannot succeed. Large objects ` +
      `already committed upload through their history, so untracking them is not enough — ` +
      `${removeFromHistoryAdvice(null)}`,
  }),
  secret_committed: ({ detail }) => {
    // The server joins the offending basenames with ', ' (vc/receive.ts).
    // Split on that exact separator, not on every comma — a basename can
    // legally contain one (`.env.a,b`), and a fragmented name would send the
    // recovery (`git rebase -i` back past the commit that added '<name>')
    // after a file that does not exist.
    const files = (detail ?? '')
      .split(', ')
      .map((name) => name.trim())
      .filter(Boolean)
    // The condition is known from the code alone; the names only sharpen the
    // recovery. Without them (a server that omitted the detail) the slug still
    // holds and the recovery is stated generically.
    return {
      code: SECRET_IN_HISTORY_CODE,
      message:
        files.length > 0
          ? secretRecoverySentence(files, 'push again')
          : 'A secret file is committed in the history being pushed. Rewrite that history to drop it (untracking alone is not enough), then push again.',
    }
  },
  missing_objects: () => ({
    code: 'missing_objects',
    message: 'Retry; if it persists, report it with `deepspace feedback`.',
  }),
  thin_pack: () => ({
    code: 'thin_pack',
    // `pushToSpace` already retried once with `--no-thin`; reaching a caller
    // means that retry also failed.
    message: 'Retry with `git push --no-thin`; if it persists, report it with `deepspace feedback`.',
  }),
  // No `stale_ref` entry: it is encoded once, in `parsePushPorcelain`, as the
  // `ref_conflict` STATUS. That is what drives the pull action and exit 2, and
  // it is why no caller can reach this table with that code.
  funny_refname: () => ({
    code: 'funny_refname',
    message: 'Rename the branch to a valid git ref name, then push again.',
  }),
  workspace_creator: () => ({
    code: 'workspace_creator',
    message:
      'Another agent owns that workspace ref. Publish your own with `deepspace workspace sync`.',
  }),
  internal_ref: () => ({
    code: 'internal_ref',
    message: 'That ref namespace is managed by DeepSpace. Push a branch instead.',
  }),
  bad_tip: () => ({
    code: 'bad_tip',
    message: 'Point the branch at a commit (not a tag or tree object), then push again.',
  }),
  unpacker_error: () => ({
    code: 'unpacker_error',
    message:
      'The server could not unpack this push. Report it with `deepspace feedback` — a plain ' +
      'retry sends the identical pack.',
  }),
  // The server has no more specific code; its own sentence is the whole fact,
  // so this reads exactly like an untagged rejection.
  push_failed: () => GENERIC_REJECTION,
  // Reaching here means `representativeResult` found nothing better — every
  // ref reported "not attempted", so the refusal that stopped the push was
  // never reported. Re-running would produce the same incomplete report, so
  // say what is actually true rather than prescribing a loop.
  not_attempted: () => ({
    code: 'rejected',
    message:
      'The push is atomic and every ref reports "not attempted", so the server did not ' +
      'report the refusal that stopped it. That should not happen — send this output with ' +
      '`deepspace feedback`.',
  }),
}

/**
 * The ONE place a server `ng` reason becomes a CLI code plus its advice.
 *
 * `pushFailureMessage` (the human sentence) and the push commands (the `--json`
 * code) both read it, so the prose a human sees and the slug an agent branches
 * on cannot describe different failures.
 *
 * An untagged or unrecognised reason is the catch-all `rejected`; the server's
 * own sentence still reaches the caller through `pushFailureMessage`. That is
 * the entire story for a CLI talking to a worker older than the refusal table,
 * and for a code added server-side that this CLI cannot yet explain — a slug
 * the CLI does not understand must not enter the public contract. There is
 * deliberately no prose fallback.
 */
export function classifyRejection(reason: string, cwd?: string): RejectionVerdict {
  const parsed = parseRefusalCode(reason)
  // Object.hasOwn, not a bare index: `__proto__`, `constructor` and `toString`
  // all live on the prototype chain and all match the code pattern, so a bare
  // lookup answered a pusher-influenced code with a throw or a slug-less
  // verdict. Only the table's own keys are codes.
  if (parsed && Object.hasOwn(REFUSAL_ADVICE, parsed.code)) {
    return REFUSAL_ADVICE[parsed.code]({ detail: parsed.detail, cwd })
  }
  return GENERIC_REJECTION
}

/**
 * `subject` is a NOUN PHRASE naming what was attempted ("The land push",
 * "Workspace upload") — this supplies the verb. A subject that already carries
 * one splices into "… rejected main failed (rejected: …)".
 */
export function pushFailureMessage(subject: string, push: PushRefResult, cwd?: string): string {
  const reason = push.reason ?? push.summary ?? ''
  // The human line shows the SENTENCE; the machine token is already the
  // envelope's `code` and would only be noise here.
  const sentence = parseRefusalCode(reason)?.sentence ?? reason
  const detail = `${push.status}${sentence ? `: ${sentence}` : ''}`
  return `${subject} failed (${detail}). ${classifyRejection(reason, cwd).message}`
}
