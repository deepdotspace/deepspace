/**
 * `wranglerConfigUncommitted` decides whether `app init` may offer
 * `git commit … -- wrangler.toml` as an executable action. The predicate has
 * to match git's own behavior exactly: the action is only honest in the one
 * state where that command succeeds — a tracked, non-conflicted, uncommitted
 * modification.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { wranglerConfigUncommitted } from '../init'

let dir: string | undefined

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
}

function makeRepo(): string {
  dir = mkdtempSync(join(tmpdir(), 'ds-init-'))
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@example.test'])
  git(['config', 'user.name', 'Test'])
  return dir
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('wranglerConfigUncommitted', () => {
  it('is false outside a git repo', () => {
    dir = mkdtempSync(join(tmpdir(), 'ds-init-'))
    expect(wranglerConfigUncommitted(dir)).toBe(false)
  })

  it('is false for an untracked wrangler.toml — the offered commit would not match the pathspec', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "x"\n')
    expect(wranglerConfigUncommitted(repo)).toBe(false)
  })

  it('is false when the file matches HEAD — the offered commit would fail with nothing to commit', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "x"\n')
    git(['add', 'wrangler.toml'])
    git(['commit', '-q', '-m', 'init'])
    expect(wranglerConfigUncommitted(repo)).toBe(false)
  })

  it('is true for a tracked unstaged modification, and the offered command succeeds', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "x"\n')
    git(['add', 'wrangler.toml'])
    git(['commit', '-q', '-m', 'init'])
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "x"\n[vars]\nDEEPSPACE_APP_ID = "app_1"\n')

    expect(wranglerConfigUncommitted(repo)).toBe(true)
    git(['commit', '-m', 'register', '--', 'wrangler.toml'])
    expect(wranglerConfigUncommitted(repo)).toBe(false)
  })

  it('is true for a staged modification', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "x"\n')
    git(['add', 'wrangler.toml'])
    git(['commit', '-q', '-m', 'init'])
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "y"\n')
    git(['add', 'wrangler.toml'])
    expect(wranglerConfigUncommitted(repo)).toBe(true)
  })

  it('is false during ANY merge in progress — git refuses every partial commit mid-merge', () => {
    // The conflict is in an unrelated file and wrangler.toml is cleanly
    // modified; porcelain would say ` M`, but the offered command still fails.
    const repo = makeRepo()
    writeFileSync(join(repo, 'other.txt'), 'base\n')
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "x"\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'base'])
    git(['switch', '-q', '-c', 'other'])
    writeFileSync(join(repo, 'other.txt'), 'other\n')
    git(['commit', '-q', '-am', 'other'])
    git(['switch', '-q', 'main'])
    writeFileSync(join(repo, 'other.txt'), 'main\n')
    git(['commit', '-q', '-am', 'main'])
    try {
      git(['merge', 'other'])
    } catch {
      // Conflict expected.
    }
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "modified"\n')
    expect(wranglerConfigUncommitted(repo)).toBe(false)
  })

  it('is false for an unmerged (conflicted) file — git refuses a partial commit mid-merge', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "base"\n')
    git(['add', 'wrangler.toml'])
    git(['commit', '-q', '-m', 'base'])
    git(['switch', '-q', '-c', 'other'])
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "other"\n')
    git(['commit', '-q', '-am', 'other'])
    git(['switch', '-q', 'main'])
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "main"\n')
    git(['commit', '-q', '-am', 'main'])
    try {
      git(['merge', 'other'])
    } catch {
      // Conflict expected — that is the state under test.
    }
    expect(wranglerConfigUncommitted(repo)).toBe(false)
  })
})
