import { shQuote } from '../cli-format'
import { SPACE_REMOTE } from '../vc-remote'
import { runGit, splitNulFields } from './process'
import { hasUnmergedEntries, interruptedGitOperation, repoToplevel } from './repository'

const SECRET_FILE_RE = /(^|\/)(\.dev\.vars(\.[^/]*)?|\.env(\.[^/]*)?|\.npmrc|\.envrc|\.mcp\.json)$/i
const SECRET_TEMPLATE_RE = /\.(example|sample|template)$/i

/** Best-effort oversized-blob diagnostics for a rejected push. */
export function findOversizedObjects(
  cwd: string,
  capBytes: number,
  limit = 3,
): { path: string; bytes: number }[] {
  try {
    const revisionObjects = runGit(cwd, ['rev-list', '--objects', '--all'], { allowFail: true })
    if (revisionObjects.status !== 0) return []
    const pathByOid = new Map<string, string>()
    for (const line of revisionObjects.stdout.toString('utf-8').split('\n')) {
      const separator = line.indexOf(' ')
      if (separator > 0) pathByOid.set(line.slice(0, separator), line.slice(separator + 1))
    }

    const sizedObjects = runGit(
      cwd,
      [
        'cat-file',
        '--batch-all-objects',
        '--batch-check=%(objectname) %(objecttype) %(objectsize)',
      ],
      { allowFail: true },
    )
    if (sizedObjects.status !== 0) return []
    const oversized: { path: string; bytes: number }[] = []
    for (const line of sizedObjects.stdout.toString('utf-8').split('\n')) {
      const [oid, type, size] = line.split(' ')
      if (type !== 'blob') continue
      const bytes = Number(size)
      const path = pathByOid.get(oid)
      if (path && Number.isFinite(bytes) && bytes > capBytes) oversized.push({ path, bytes })
    }
    return oversized.sort((left, right) => right.bytes - left.bytes).slice(0, limit)
  } catch {
    return []
  }
}

/** Dirty paths safe to expose in logs; local secret filenames are redacted. */
export function statusFiles(cwd: string): string[] {
  const records = splitNulFields(
    runGit(cwd, [
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain',
      '--untracked-files=all',
      '-z',
    ]).stdout,
  )
  const files: string[] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    files.push(record.slice(3))
    if (/[RC]/.test(record.slice(0, 2))) {
      index++
      if (/R/.test(record.slice(0, 2)) && index < records.length) files.push(records[index])
    }
  }
  return [
    ...new Set(
      files.filter((path) => !(SECRET_FILE_RE.test(path) && !SECRET_TEMPLATE_RE.test(path))),
    ),
  ]
}

/** Secret-bearing files in a committed tree, scanned from the repository root. */
export function trackedSecretFiles(cwd: string, ref: string): string[] {
  const result = runGit(
    repoToplevel(cwd),
    ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', '-z', ref],
    { allowFail: true },
  )
  if (result.status !== 0) return []
  return splitNulFields(result.stdout).filter(
    (path) => SECRET_FILE_RE.test(path) && !SECRET_TEMPLATE_RE.test(path),
  )
}

/**
 * The revisions a push would actually upload, as `git log` arguments.
 *
 * With a known base for this branch it is the plain range. Without one, the
 * answer is NOT "everything" — it is everything the server does not already
 * have, which `--not <space refs>` states exactly and without having to pick
 * among several merge-bases. Falling back to the whole history instead made a
 * secret in accepted trunk history refuse every new branch cut from trunk.
 */
function pushRange(root: string, base: string | null, tip: string): string[] {
  // `--root` in every branch: a root commit inside the range must show its
  // adds even when the user has `log.showRoot=false`, or a secret added in a
  // new root (an orphan branch, a reset past the first commit) passes the
  // local scan and is only refused server-side.
  if (base) return ['--root', `${base}..${tip}`]
  const listed = runGit(
    root,
    ['for-each-ref', '--format=%(refname)', `refs/remotes/${SPACE_REMOTE}/`],
    { allowFail: true },
  )
  const spaceRefs =
    listed.status === 0
      ? listed.stdout
          .toString('utf-8')
          .split('\n')
          .map((ref) => ref.trim())
          .filter(Boolean)
      : []
  // No space refs at all: nothing on the server to exclude, so the whole
  // history is genuinely what this push sends.
  return spaceRefs.length === 0 ? ['--root', tip] : ['--root', tip, '--not', ...spaceRefs]
}

/**
 * Secret-bearing files anywhere in the commits a push would upload — not just
 * at the tip.
 *
 * The server scans every pushed TREE by basename, so a secret added in one
 * commit and removed in a later one still refuses: its tree and blob ride the
 * pack through ancestry. A tip-only check calls that clean, which lets
 * `git rm --cached` + commit pass locally and be rejected by the server from
 * inside git's transport, with no envelope. Checking what the server checks
 * puts the refusal here, in a shape an agent can act on.
 *
 * `base` null means this BRANCH has no known remote tip — which is the normal
 * state for every new branch, not just a new repo. Scanning to the root there
 * would refuse a branch for a secret that is already in accepted trunk
 * history and has nothing to do with this push. What the push actually
 * uploads is what the server does not already have, so the walk excludes
 * everything reachable from the known space refs. Only when there are NO
 * space refs at all — the repo's genuine first push — does it walk to the
 * root, and there every commit really is being sent.
 */
export function secretFilesInPushRange(cwd: string, base: string | null, tip: string): string[] {
  const root = repoToplevel(cwd)
  const found = new Set(trackedSecretFiles(root, tip))
  // Files ADDED anywhere in what is being sent — the add-then-delete case the
  // tip scan cannot see.
  const result = runGit(
    root,
    [
      '-c',
      'core.quotePath=false',
      'log',
      // Rename detection is on by default, so `git mv notes.txt .env` is
      // reported as R100 and never as an addition — while the blob still
      // rides the pack and the server still refuses it.
      '--no-renames',
      '--diff-filter=A',
      '--name-only',
      '--pretty=format:',
      '-z',
      ...pushRange(root, base, tip),
    ],
    { allowFail: true },
  )
  if (result.status !== 0) {
    // A history we could not walk is not an empty history; the tip scan above
    // already stands as the answer, so report that rather than claiming
    // nothing was added.
    return [...found]
  }
  for (const path of splitNulFields(result.stdout)) {
    if (path && SECRET_FILE_RE.test(path) && !SECRET_TEMPLATE_RE.test(path)) found.add(path)
  }
  return [...found]
}

export const SECRET_IN_HISTORY_CODE = 'secret_in_history'

/** The recovery for a secret already committed. Untracking alone does NOT fix
 *  it — the blob still rides the pack through the earlier commit — so this
 *  names the two things that do, and the rotation that neither replaces. */
export function secretRecoverySentence(files: string[], then: string): string {
  // Every caller has at least one file: the local scan returns null when it
  // finds none, and the server names them in the refusal's detail.
  const first = shQuote(files[0])
  // NO "or rename it": the offending ADD is inside the range being sent, so a
  // rename leaves that commit — and this refusal — exactly as it was, while
  // costing the agent the file name the message was keyed to. Rewriting the
  // history that carries it is the only thing that clears it.
  return (
    `Untracking alone will not fix this: the file is already in the commits being sent, so its ` +
    `contents upload through history either way. Rewrite the history that carries it — ` +
    `\`git rebase -i\` back past the commit that added ${first}, or ` +
    `\`git reset --soft\` to before it and re-commit without the file — and add it to ` +
    `.gitignore, then ${then}. Treat any credential it held as exposed and rotate it.`
  )
}

export function committedSecretRefusal(
  cwd: string,
  commitOid: string | null,
  options: { action: string; then: string; base?: string | null },
): { files: string[]; message: string; code: string } | null {
  if (!commitOid) return null
  // Range form when the caller knows a base; tip-only when `base` is absent
  // entirely (an explicit `null` base still means "range, unbounded").
  const files =
    options.base === undefined
      ? trackedSecretFiles(cwd, commitOid)
      : secretFilesInPushRange(cwd, options.base, commitOid)
  if (files.length === 0) return null
  return {
    files,
    code: SECRET_IN_HISTORY_CODE,
    message:
      `Refusing to ${options.action}: the commit being published carries secret file(s) — ` +
      `${files.join(', ')}. These hold local secrets and must not reach the cloud repo, ` +
      `but publishing this commit would upload them through its history. ` +
      secretRecoverySentence(files, options.then),
  }
}

/**
 * The refusal for a worktree whose INDEX carries unmerged entries, or whose
 * checkout is mid-operation.
 *
 * One function because every verb meeting this state has to give the same
 * answer: "uncommitted changes — commit them" commits the `<<<<<<<` markers.
 * The branches below distinguish OUR merge from someone else's unfinished
 * operation from conflicts with no operation at all, because the prescribed
 * command differs for each and the wrong one is rejected by git itself.
 */
export function unmergedIndexRefusal(
  cwd: string,
  opts: {
    /** e.g. "The merge this land needs", used only for the OUR-merge case. */
    ours: string
    resume: string
  },
): { message: string; code: string; operation: string | null } | null {
  // Keyed on the OPERATION first, not the index. `hasUnmergedEntries` reads
  // `ls-files -u`, which one `git add` empties — and `git commit -am`
  // succeeds over a staged-but-unresolved merge in a single command,
  // committing the <<<<<<< markers. MERGE_HEAD and its siblings survive
  // staging, so they are what "a conflict is unfinished here" really means.
  const marker = interruptedGitOperation(cwd)
  const unmerged = hasUnmergedEntries(cwd)
  // A bisect is a deliberate walk, not a stalled operation, and it does not
  // own the index. With a clean index there is nothing to refuse; with a
  // CONFLICTED one the conflict came from something else (a stash pop, a
  // squash merge), so it is treated as unowned rather than swallowed —
  // returning null there let "commit them" through, which commits the markers.
  const operation = marker === 'bisect' ? null : marker
  if (operation === null && !unmerged) return null
  // An operation marker with a CLEAN index is a DIFFERENT state, and the
  // conflict wording is simply false there: `git rebase -i` stopped at `edit`
  // never conflicted, and a conflict whose files were staged has nothing
  // unresolved left in the index. What is still true is that the operation
  // owns this checkout until it is finished or abandoned. The marker caution
  // stays conditional, because from here the two cases are indistinguishable.
  if (operation !== null && !unmerged) {
    return {
      operation,
      code: 'git_operation_in_progress',
      message:
        `A ${operation} is in progress in this checkout — finish it ` +
        `(\`git ${operation} --continue\`) or abort it (\`git ${operation} --abort\`), ` +
        `then re-run \`${opts.resume}\`. If it stopped at a conflict, anything already ` +
        `staged can still carry \`<<<<<<<\` markers; staging is not resolving.`,
    }
  }
  if (operation === 'merge' || operation === null) {
    return {
      operation,
      code: 'merge_conflict',
      message:
        (operation === 'merge'
          ? `${opts.ours} is already in progress here, stopped at unresolved conflicts. `
          : `The index has unresolved conflicts with no operation to continue — a squash merge or a stash pop. `) +
        `Resolve the conflicted files (remove the \`<<<<<<<\` markers), \`git add\` them, ` +
        (operation === 'merge'
          ? `\`git commit\`, then re-run \`${opts.resume}\`. To abandon the merge instead: \`git merge --abort\`.`
          : `\`git commit\`, then re-run \`${opts.resume}\`. To discard them instead: \`git reset --merge\`.`),
    }
  }
  return {
    operation,
    code: 'git_operation_in_progress',
    message:
      `A ${operation} is unfinished in this checkout with unresolved conflicts — finish it ` +
      `(\`git ${operation} --continue\` after resolving, or \`git ${operation} --abort\`), ` +
      `then re-run \`${opts.resume}\`.`,
  }
}
