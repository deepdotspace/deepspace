/**
 * The scaffold's first commit must leave the repo able to make a SECOND one.
 *
 * `deepspace deploy` requires a commit, and in a container with no global Git
 * config the caller's next commit died with "unable to auto-detect email
 * address" (exit 128) — because the scaffold's identity only ever existed as
 * `git -c user.name=… -c user.email=…` on one argv and was never written down.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCAFFOLD_GIT_IDENTITY, commitInitialScaffold } from '../setup-runtime'

/**
 * This is the only suite here that shells out, and each case spawns several
 * `git` processes. Vitest's 5s default is comfortable alone but not under
 * `turbo run test`, which runs 18 tasks at once — the suite then times out on a
 * loaded machine and fails a release over a test that is not broken. Generous
 * enough to absorb that contention, far short of masking a hang.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

/**
 * Run git with NO ambient identity, the way a fresh container has none:
 * global/system config emptied and the identity env vars REMOVED. They are
 * deleted rather than blanked because an empty `GIT_AUTHOR_NAME` outranks
 * config and fails with a different error ("empty ident name"), which would
 * mask whether the local config is being read at all.
 */
function git(cwd: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
  for (const key of [
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'EMAIL',
  ]) {
    delete env[key]
  }
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env }).trim()
}

describe('commitInitialScaffold', () => {
  let appDir: string
  let priorEnv: Record<string, string | undefined>

  beforeEach(() => {
    appDir = mkdtempSync(join(tmpdir(), 'ds-scaffold-'))
    priorEnv = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
      EMAIL: process.env.EMAIL,
    }
    // The scaffolder shells out itself, so the "no identity anywhere" condition
    // has to be in this process's environment.
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    process.env.GIT_CONFIG_SYSTEM = '/dev/null'
    for (const key of [
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
      'EMAIL',
    ]) {
      delete process.env[key]
    }
    git(appDir, ['init', '-q'])
    writeFileSync(join(appDir, 'README.md'), '# app\n')
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(appDir, { recursive: true, force: true })
  })

  it('persists the identity it commits with, so the NEXT commit succeeds', () => {
    commitInitialScaffold(appDir, true)

    expect(git(appDir, ['config', '--local', 'user.name'])).toBe(SCAFFOLD_GIT_IDENTITY.name)
    expect(git(appDir, ['config', '--local', 'user.email'])).toBe(SCAFFOLD_GIT_IDENTITY.email)
    expect(git(appDir, ['log', '-1', '--pretty=%an <%ae>'])).toBe(
      `${SCAFFOLD_GIT_IDENTITY.name} <${SCAFFOLD_GIT_IDENTITY.email}>`,
    )

    // The regression: this is the commit `deepspace deploy` needs, and it used
    // to exit 128 in exactly this environment.
    writeFileSync(join(appDir, 'src.ts'), 'export const x = 1\n')
    git(appDir, ['add', '-A'])
    expect(() => git(appDir, ['commit', '-m', 'second'])).not.toThrow()
    expect(git(appDir, ['rev-list', '--count', 'HEAD'])).toBe('2')
  })

  it('uses an existing effective identity without shadowing it locally', () => {
    const globalConfig = join(appDir, '.git', 'test-global-config')
    execFileSync('git', ['config', '--file', globalConfig, 'user.name', 'Actual Developer'])
    execFileSync('git', ['config', '--file', globalConfig, 'user.email', 'actual@example.com'])
    process.env.GIT_CONFIG_GLOBAL = globalConfig

    commitInitialScaffold(appDir, true)

    expect(() => git(appDir, ['config', '--local', 'user.name'])).toThrow()
    expect(() => git(appDir, ['config', '--local', 'user.email'])).toThrow()
    expect(git(appDir, ['log', '-1', '--pretty=%an <%ae>'])).toBe(
      'Actual Developer <actual@example.com>',
    )

    writeFileSync(join(appDir, 'src.ts'), 'export const x = 1\n')
    git(appDir, ['add', '-A'])
    expect(() =>
      execFileSync('git', ['commit', '-m', 'second'], {
        cwd: appDir,
        env: process.env,
        stdio: 'ignore',
      }),
    ).not.toThrow()
  })

  it('preserves a configured name combined with the standard EMAIL fallback', () => {
    git(appDir, ['config', 'user.name', 'Actual Developer'])
    process.env.EMAIL = 'actual@example.com'

    commitInitialScaffold(appDir, true)

    expect(git(appDir, ['config', '--local', 'user.name'])).toBe('Actual Developer')
    expect(git(appDir, ['config', '--local', 'user.email'])).toBe('actual@example.com')
    expect(git(appDir, ['log', '-1', '--pretty=%an <%ae>'])).toBe(
      'Actual Developer <actual@example.com>',
    )
  })

  it('preserves an environment name combined with a configured email', () => {
    git(appDir, ['config', 'user.email', 'actual@example.com'])
    process.env.GIT_AUTHOR_NAME = 'Actual Developer'
    process.env.GIT_COMMITTER_NAME = 'Actual Developer'

    commitInitialScaffold(appDir, true)

    expect(git(appDir, ['config', '--local', 'user.name'])).toBe('Actual Developer')
    expect(git(appDir, ['config', '--local', 'user.email'])).toBe('actual@example.com')
    expect(git(appDir, ['log', '-1', '--pretty=%an <%ae>'])).toBe(
      'Actual Developer <actual@example.com>',
    )
  })

  it('leaves a repository it did not create alone', () => {
    commitInitialScaffold(appDir, false)
    expect(() => git(appDir, ['rev-parse', 'HEAD'])).toThrow()
  })
})
