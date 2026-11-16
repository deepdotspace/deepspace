/**
 * CLI state inside a project must never make deploy's dirty-worktree check
 * fail: a recovered raw app has no .gitignore, and the deploy lock is taken
 * before that check.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireDeployLock } from '../../commands/deploy/lock'
import { appStateDir } from '../app-state'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
const exclude = (cwd: string) => readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf-8')

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('appStateDir', () => {
  it('keeps the deploy lock out of an unignored checkout', () => {
    dir = mkdtempSync(join(tmpdir(), 'ds-app-state-'))
    git(dir, 'init', '-q')
    const release = acquireDeployLock(dir)
    try {
      expect(existsSync(join(dir, '.deepspace', 'deploy.lock'))).toBe(true)
      expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    } finally {
      release()
    }
    expect(exclude(dir).split('\n')).toContain('.deepspace')
    appStateDir(dir)
    expect(
      exclude(dir)
        .split('\n')
        .filter((line) => line === '.deepspace'),
    ).toHaveLength(1)
  })

  it('leaves a project that already ignores its state untouched', () => {
    dir = mkdtempSync(join(tmpdir(), 'ds-app-state-'))
    git(dir, 'init', '-q')
    writeFileSync(join(dir, '.gitignore'), '.deepspace\n')
    const before = exclude(dir)
    writeFileSync(join(appStateDir(dir), 'install.started'), 'now')
    expect(exclude(dir)).toBe(before)
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('?? .gitignore')
  })

  it('works outside a Git checkout', () => {
    dir = mkdtempSync(join(tmpdir(), 'ds-app-state-'))
    expect(existsSync(appStateDir(dir))).toBe(true)
    expect(existsSync(join(dir, '.git'))).toBe(false)
  })
})
