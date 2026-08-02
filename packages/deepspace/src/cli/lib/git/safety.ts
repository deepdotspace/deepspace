import { shQuote } from '../cli-format'
import { runGit, splitNulFields } from './process'
import { repoToplevel } from './repository'

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

export const SECRET_IN_HISTORY_CODE = 'secret_in_history'

export function committedSecretRefusal(
  cwd: string,
  commitOid: string | null,
  options: { action: string; then: string },
): { files: string[]; message: string; code: string } | null {
  if (!commitOid) return null
  const files = trackedSecretFiles(cwd, commitOid)
  if (files.length === 0) return null
  return {
    files,
    code: SECRET_IN_HISTORY_CODE,
    message:
      `Refusing to ${options.action}: the commit being published carries secret file(s) — ` +
      `${files.join(', ')}. These hold local secrets and must not reach the cloud repo, ` +
      `but pushing this commit would upload them through its history. ` +
      `Untrack with \`git rm --cached ${shQuote(files[0])}\`, ensure it's .gitignored, commit, ` +
      `then ${options.then}.`,
  }
}
