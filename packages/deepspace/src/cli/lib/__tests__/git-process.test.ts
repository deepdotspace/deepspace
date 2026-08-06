/** Process hardening and Git-version parsing. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GIT_TIMEOUT_MS, GitError, gitMeetsFloor, parseGitVersion, runGit } from '../git/process'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ds-git-process-'))
  runGit(dir, ['init', '--quiet'])
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('spawn environment hardening', () => {
  it('sets GIT_TERMINAL_PROMPT=0 and LC_ALL=C on every git invocation', () => {
    // A shell alias echoes the child's environment, proving what spawn passes.
    const out = runGit(dir, ['-c', 'alias.senv=!env', 'senv']).stdout.toString('utf-8')
    expect(out).toMatch(/^GIT_TERMINAL_PROMPT=0$/m)
    expect(out).toMatch(/^LC_ALL=C$/m)
  })

  it('stops a git call that would otherwise block forever', () => {
    // `spawnSync` blocks the whole CLI, so an unbounded git call is a silent
    // hang with no output and no recovery — a deploy was observed sitting on
    // one for minutes. A shell alias gives us a genuinely wedged child.
    const started = Date.now()
    let error: unknown
    try {
      runGit(dir, ['-c', 'alias.hang=!sleep 30', 'hang'], { timeoutMs: 750 })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).code).toBe('git_timeout')
    expect((error as GitError).message).toContain('did not finish within 1s')
    // The point is that it RETURNED, long before the child's own 30s.
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('caps every invocation by default, not only when a caller asks', () => {
    // The ceiling has to be the default: the hang was in a call site that
    // passed no options at all.
    expect(GIT_TIMEOUT_MS).toBeGreaterThan(0)
    expect(GIT_TIMEOUT_MS).toBeLessThanOrEqual(300_000)
  })

  it('applies caller env overlays on top of the hardening defaults', () => {
    const out = runGit(dir, ['-c', 'alias.senv=!env', 'senv'], {
      env: { DS_TEST_SENTINEL: 'yes' },
    }).stdout.toString('utf-8')
    expect(out).toMatch(/^DS_TEST_SENTINEL=yes$/m)
    expect(out).toMatch(/^GIT_TERMINAL_PROMPT=0$/m)
  })
})

describe('Git 2.29 version floor', () => {
  // The floor is checked by version because old Git versions can echo an
  // unknown --show-object-format flag to stdout while exiting successfully.
  it('parses common version strings and rejects non-version output', () => {
    expect(parseGitVersion('git version 2.52.0')).toEqual([2, 52])
    expect(parseGitVersion('git version 2.29.0.windows.1')).toEqual([2, 29])
    expect(parseGitVersion('git version 2.39.3 (Apple Git-146)')).toEqual([2, 39])
    expect(parseGitVersion('git version 1.9.5')).toEqual([1, 9])
    expect(parseGitVersion('--show-object-format')).toBeNull()
    expect(parseGitVersion('not a version')).toBeNull()
  })

  it('holds the floor and defers an unparseable version to the format probe', () => {
    expect(gitMeetsFloor([2, 29])).toBe(true)
    expect(gitMeetsFloor([2, 30])).toBe(true)
    expect(gitMeetsFloor([3, 0])).toBe(true)
    expect(gitMeetsFloor([2, 28])).toBe(false)
    expect(gitMeetsFloor([2, 26])).toBe(false)
    expect(gitMeetsFloor([1, 9])).toBe(false)
    expect(gitMeetsFloor(null)).toBe(true)
  })
})
