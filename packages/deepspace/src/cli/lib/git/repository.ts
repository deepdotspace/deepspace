import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { InputError } from '../cli-errors'
import { gitLine, gitMeetsFloor, parseGitVersion, runGit, splitNulFields } from './process'

/** Conservative client-side approximation of `git check-ref-format --branch`. */
export function isPlausibleBranchName(name: string): boolean {
  if (!name || name === 'HEAD' || name === '@') return false
  if (name.startsWith('/') || name.startsWith('-') || name.startsWith('.')) return false
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false
  if (name.includes('/.') || name.includes('.lock/')) return false
  // eslint-disable-next-line no-control-regex
  return !/(\.\.|\/\/|@\{|[\x00-\x20\x7f~^:?*[\\])/.test(name)
}

/** Require a full, SHA-1 Git repository supported by the cloud repo protocol. */
export function assertSyncableRepo(cwd: string): void {
  const inside = runGit(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFail: true })
  if (inside.status !== 0 || inside.stdout.toString().trim() !== 'true') {
    throw new InputError(
      `${cwd} is not a git repository. DeepSpace apps are scaffolded as git repos — run \`git init\` first.`,
      'not_git_repo',
    )
  }

  const versionOutput = runGit(cwd, ['--version'], { allowFail: true })
    .stdout.toString('utf-8')
    .trim()
  if (!gitMeetsFloor(parseGitVersion(versionOutput))) {
    throw gitTooOld(versionOutput)
  }

  const formatResult = runGit(cwd, ['rev-parse', '--show-object-format'], { allowFail: true })
  const format = formatResult.stdout.toString('utf-8').trim()
  if (formatResult.status !== 0 || format.startsWith('--')) throw gitTooOld(versionOutput)
  if (format !== 'sha1') {
    throw new InputError(
      `This repo uses object format "${format}" — DeepSpace version control supports sha1 repos only (git's default) for now.`,
      'unsupported_object_format',
    )
  }
  if (gitLine(cwd, ['rev-parse', '--is-shallow-repository']) === 'true') {
    throw new InputError(
      'This is a shallow clone. Run `git fetch --unshallow` before pushing to DeepSpace.',
      'shallow_repo',
    )
  }
}

function gitTooOld(versionOutput: string): InputError {
  return new InputError(
    `DeepSpace version control needs git ≥ 2.29 — found ${versionOutput || 'an unknown git version'}. Upgrade git and retry.`,
    'git_too_old',
  )
}

/** The repository's top-level worktree directory. */
export function repoToplevel(cwd: string): string {
  return gitLine(cwd, ['rev-parse', '--show-toplevel'])
}

/** Current branch short name, or null when HEAD is detached. */
export function currentBranch(cwd: string): string | null {
  const result = runGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true })
  const name = result.stdout.toString('utf-8').trim()
  return result.status === 0 && name ? name : null
}

/** Resolve a ref or oid to a commit oid. */
export function resolveCommit(cwd: string, ref: string): string | null {
  const result = runGit(cwd, ['rev-parse', '-q', '--verify', `${ref}^{commit}`], {
    allowFail: true,
  })
  const oid = result.stdout.toString('utf-8').trim()
  return result.status === 0 && /^[0-9a-f]{40}$/.test(oid) ? oid : null
}

export function isWorkTreeClean(cwd: string): boolean {
  return gitLine(cwd, ['status', '--porcelain']) === ''
}

export function updateRef(cwd: string, ref: string, oid: string): void {
  runGit(cwd, ['update-ref', ref, oid])
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return (
    runGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFail: true })
      .status === 0
  )
}

export function mergeBase(cwd: string, left: string, right: string): string | null {
  const result = runGit(cwd, ['merge-base', left, right], { allowFail: true })
  if (result.status !== 0) return null
  const oid = result.stdout.toString('utf-8').trim()
  return /^[0-9a-f]{40}$/.test(oid) ? oid : null
}

export function fastForwardCurrentBranch(cwd: string, oid: string): void {
  runGit(cwd, ['merge', '--ff-only', oid])
}

export function initRepo(dir: string, branch: string): void {
  runGit(dir, ['init', '--quiet', '-b', branch])
}

export function checkoutHead(cwd: string): void {
  runGit(cwd, ['reset', '--hard', '--quiet'])
}

export function switchToNewBranch(cwd: string, name: string, oid: string): void {
  runGit(cwd, ['switch', '--quiet', '-c', name, oid])
}

/** Changed paths between commits, with rename detection disabled so both sides remain visible. */
export function diffNameOnly(cwd: string, base: string, head: string): string[] {
  return splitNulFields(
    runGit(cwd, [
      '-c',
      'core.quotePath=false',
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      base,
      head,
    ]).stdout,
  )
}

export function revListCount(cwd: string, exclude: string, include: string): number {
  const count = Number(gitLine(cwd, ['rev-list', '--count', `${exclude}..${include}`]))
  return Number.isFinite(count) ? count : 0
}

export function addWorktreeNewBranch(cwd: string, dir: string, branch: string, oid: string): void {
  runGit(cwd, ['worktree', 'add', '--quiet', '-b', branch, dir, oid])
}

export interface GitWorktree {
  path: string
  branch: string | null
}

export function listWorktrees(cwd: string): GitWorktree[] {
  const result = runGit(cwd, ['worktree', 'list', '--porcelain'], { allowFail: true })
  if (result.status !== 0) return []
  const worktrees: GitWorktree[] = []
  let current: GitWorktree | null = null
  for (const line of result.stdout.toString('utf-8').split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null }
      worktrees.push(current)
    } else if (line.startsWith('branch ') && current) {
      const ref = line.slice('branch '.length)
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    }
  }
  return worktrees
}

/** Add a pattern to the repository's shared, local-only info/exclude file. */
export function ensureLocalExclude(cwd: string, pattern: string): void {
  const commonDir = resolve(cwd, gitLine(cwd, ['rev-parse', '--git-common-dir']))
  const excludePath = join(commonDir, 'info', 'exclude')
  let current = ''
  try {
    current = readFileSync(excludePath, 'utf-8')
  } catch {
    // The append below creates an absent file.
  }
  if (current.split('\n').some((line) => line.trim() === pattern)) return
  try {
    mkdirSync(dirname(excludePath), { recursive: true })
    appendFileSync(
      excludePath,
      `${current.endsWith('\n') || current === '' ? '' : '\n'}${pattern}\n`,
    )
  } catch {
    // Best-effort: a failed exclude makes status noisy but does not break the worktree.
  }
}
