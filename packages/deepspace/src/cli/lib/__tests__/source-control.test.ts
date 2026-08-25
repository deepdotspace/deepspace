import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGit } from '../git/process'
import {
  githubRepositoryFromUrl,
  isGitCredentialFailure,
  listGitHubRemotes,
  localTransferRefs,
  selectGitHubRemote,
} from '../source-control'

describe('GitHub URL canonicalization', () => {
  it.each([
    ['git@github.com:DeepSpaceRepos/Source-Test.git', 'deepspacerepos/source-test'],
    ['https://github.com/DeepSpaceRepos/Source-Test', 'deepspacerepos/source-test'],
    ['ssh://git@github.com/DeepSpaceRepos/Source-Test.git', 'deepspacerepos/source-test'],
  ])('maps %s to %s', (url, repository) => {
    expect(githubRepositoryFromUrl(url)).toBe(repository)
  })

  it.each([
    'https://gitlab.com/owner/repo',
    'https://github.com/owner',
    'not a url',
    'git@example.com:owner/repo.git',
  ])('rejects non-GitHub or malformed URL %s', (url) => {
    expect(githubRepositoryFromUrl(url)).toBeNull()
  })
})

describe('Git credential diagnostics', () => {
  it.each([
    'fatal: Authentication failed',
    'fatal: could not read Username for github.com: terminal prompts disabled',
    'git@github.com: Permission denied (publickey).',
    'ERROR: Repository not found.',
  ])('recognizes %s', (message) => {
    expect(isGitCredentialFailure(new Error(message))).toBe(true)
  })

  it('does not relabel unrelated transport failures', () => {
    expect(isGitCredentialFailure(new Error('connection timed out'))).toBe(false)
  })
})

describe('GitHub remote selection', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ds-source-control-'))
    runGit(repo, ['init', '--quiet', '-b', 'main'])
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('prefers origin and can resolve a configured repository or explicit remote', () => {
    runGit(repo, ['remote', 'add', 'backup', 'git@github.com:Acme/Backup.git'])
    runGit(repo, ['remote', 'add', 'origin', 'https://github.com/Acme/Main.git'])
    expect(listGitHubRemotes(repo)).toEqual([
      {
        name: 'backup',
        repository: 'acme/backup',
        url: 'git@github.com:Acme/Backup.git',
      },
      {
        name: 'origin',
        repository: 'acme/main',
        url: 'https://github.com/Acme/Main.git',
      },
    ])
    expect(selectGitHubRemote(repo)?.name).toBe('origin')
    expect(selectGitHubRemote(repo, { repository: 'ACME/BACKUP' })?.name).toBe('backup')
    expect(selectGitHubRemote(repo, { name: 'backup' })?.repository).toBe('acme/backup')
  })

  it('refuses to guess when multiple GitHub remotes exist without origin', () => {
    runGit(repo, ['remote', 'add', 'one', 'git@github.com:Acme/One.git'])
    runGit(repo, ['remote', 'add', 'two', 'git@github.com:Acme/Two.git'])
    expect(selectGitHubRemote(repo)).toBeNull()
  })

  it('rewrites transfer refs to their exact public names and object ids', () => {
    runGit(repo, ['config', 'user.email', 'test@example.com'])
    runGit(repo, ['config', 'user.name', 'Test'])
    runGit(repo, ['commit', '--quiet', '--allow-empty', '-m', 'initial'])
    const oid = runGit(repo, ['rev-parse', 'HEAD']).stdout.toString('utf-8').trim()
    runGit(repo, ['update-ref', 'refs/deepspace/source-transfer/heads/main', oid])
    expect(localTransferRefs(repo, 'refs/deepspace/source-transfer/heads', 'refs/heads')).toEqual([
      { name: 'refs/heads/main', oid },
    ])
  })
})
