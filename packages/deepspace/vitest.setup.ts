/**
 * Keep the test run out of the developer's own git configuration.
 *
 * The CLI suites shell out to real git. Two ways that reaches outside the
 * scratch repos:
 *
 *  - `ensureSpaceRemote` installs a credential helper at `--global` scope,
 *    pinned to the RUNNING CLI entry — which under vitest is a worker's
 *    `forks.js`. Unisolated, a test writes a permanently broken helper for the
 *    PRODUCTION host into `~/.gitconfig`.
 *  - `git config --get user.email` reads global AND system config, so a
 *    normally-configured machine makes "this repo has no identity" tests pass
 *    vacuously — and a CI box without one makes them fail.
 *
 * Loaded as a vitest `setupFiles` entry, so it covers every suite rather than
 * the ones someone remembered to annotate. Each file gets its own throwaway
 * global config: writable (git must be able to write it) but thrown away.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll } from 'vitest'

let configDir: string | undefined

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'ds-gitcfg-'))
  process.env.GIT_CONFIG_GLOBAL = join(configDir, 'gitconfig')
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
})

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})
