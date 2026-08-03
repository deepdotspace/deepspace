import { runGit } from './git/process'

export interface GitHubRemote {
  name: string
  repository: string
  url: string
}

export interface GitRef {
  name: string
  oid: string
}

/** Canonical GitHub owner/repository, or null for a non-GitHub URL. */
export function githubRepositoryFromUrl(url: string): string | null {
  const trimmed = url.trim()
  let path: string | null = null
  const scp = /^(?:[^@\s]+@)?github\.com:([^\s]+)$/i.exec(trimmed)
  if (scp) {
    path = scp[1]
  } else {
    try {
      const parsed = new URL(trimmed)
      if (parsed.hostname.toLowerCase() !== 'github.com') return null
      path = parsed.pathname.replace(/^\/+/, '')
    } catch {
      return null
    }
  }
  const repository = path.replace(/\/+$/, '').replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repository)) {
    return null
  }
  return repository.toLowerCase()
}

export function listGitHubRemotes(cwd: string): GitHubRemote[] {
  const names = runGit(cwd, ['remote'], { allowFail: true })
    .stdout.toString('utf-8')
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean)
  const remotes: GitHubRemote[] = []
  for (const name of names) {
    const result = runGit(cwd, ['remote', 'get-url', name], { allowFail: true })
    if (result.status !== 0) continue
    const url = result.stdout.toString('utf-8').trim()
    const repository = githubRepositoryFromUrl(url)
    if (repository) remotes.push({ name, repository, url })
  }
  return remotes
}

export function selectGitHubRemote(
  cwd: string,
  options: { name?: string; repository?: string } = {},
): GitHubRemote | null {
  const remotes = listGitHubRemotes(cwd)
  if (options.name) return remotes.find((remote) => remote.name === options.name) ?? null
  const repository = options.repository?.toLowerCase()
  const matching = repository
    ? remotes.filter((remote) => remote.repository === repository)
    : remotes
  return (
    matching.find((remote) => remote.name === 'origin') ??
    (matching.length === 1 ? matching[0] : null)
  )
}

/** Public branches and tags advertised by a normal Git remote. */
export function remotePublicRefs(cwd: string, remote: string): GitRef[] {
  const output = runGit(cwd, ['ls-remote', '--refs', remote]).stdout.toString('utf-8')
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [oid, name] = line.split(/\s+/, 2)
      return { oid, name }
    })
    .filter(
      (ref) =>
        /^[0-9a-f]{40}$/.test(ref.oid) &&
        (ref.name.startsWith('refs/heads/') || ref.name.startsWith('refs/tags/')),
    )
}

export function remoteBranchOid(cwd: string, remote: string, branch: string): string | null {
  return (
    remotePublicRefs(cwd, remote).find((ref) => ref.name === `refs/heads/${branch}`)?.oid ?? null
  )
}

/** Local refs under a transfer namespace, rewritten to their public names. */
export function localTransferRefs(cwd: string, prefix: string, target: string): GitRef[] {
  const output = runGit(cwd, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    prefix,
  ]).stdout.toString('utf-8')
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, oid] = line.split(/\s+/, 2)
      return { name: `${target}/${name.slice(`${prefix}/`.length)}`, oid }
    })
    .filter((ref) => /^[0-9a-f]{40}$/.test(ref.oid))
}
