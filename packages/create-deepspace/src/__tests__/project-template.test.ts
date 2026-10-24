import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configurePackageJson, writeGitignoreIfMissing } from '../project-template'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('configurePackageJson', () => {
  const noProgress = { start: () => {}, stop: () => {} }

  it.each([true, false])(
    'routes login according to the selected distribution (agent=%s)',
    (agentAccount) => {
      const appDir = mkdtempSync(join(tmpdir(), 'create-deepspace-login-'))
      tempDirs.push(appDir)
      writeFileSync(
        join(appDir, 'package.json'),
        JSON.stringify({
          name: '@deepspace/base',
          scripts: { login: 'deepspace auth login', build: 'vite build' },
          dependencies: { deepspace: 'workspace:*' },
        }),
      )
      configurePackageJson(
        appDir,
        'my-app',
        { name: 'starter', description: '' },
        '0.42.3',
        undefined,
        noProgress,
        undefined,
        agentAccount,
      )
      expect(JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).scripts).toEqual({
        login: agentAccount ? 'deepspace auth agent register --json' : 'deepspace auth login',
        build: 'vite build',
      })
    },
  )

  /**
   * `create-deepspace@X` scaffolds files generated for exactly X, so it must
   * ask for exactly X. A caret let a pinned scaffolder install a newer SDK —
   * scaffold and runtime disagreed on day one, and nothing said so.
   */
  it('pins the SDK to the creator version exactly, not to a caret range', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'create-deepspace-pkg-'))
    tempDirs.push(appDir)
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({
        name: '@deepspace/base',
        version: '0.1.0',
        files: ['dist'],
        dependencies: { deepspace: 'workspace:*', react: '^19.0.0' },
      }),
    )

    configurePackageJson(
      appDir,
      'my-app',
      { name: 'starter', description: '' },
      '0.23.2',
      undefined,
      noProgress,
    )

    expect(JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))).toMatchObject({
      name: 'my-app',
      version: '0.0.1',
      private: true,
      dependencies: { deepspace: '0.23.2', react: '^19.0.0' },
    })
  })
})

describe('writeGitignoreIfMissing', () => {
  it('ignores Playwright outputs while preserving existing entries', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'create-deepspace-gitignore-'))
    tempDirs.push(appDir)
    writeFileSync(join(appDir, '.gitignore'), 'custom-output\n')

    writeGitignoreIfMissing(appDir)
    writeGitignoreIfMissing(appDir)

    const entries = readFileSync(join(appDir, '.gitignore'), 'utf8').trim().split('\n')
    expect(entries).toContain('custom-output')
    expect(entries).toContain('test-results/')
    expect(entries).toContain('playwright-report/')
    expect(entries.filter((entry) => entry === 'test-results/')).toHaveLength(1)
  })
})

it('keeps an exact remote prototype SDK dependency for fresh-container recovery', () => {
  const appDir = mkdtempSync(join(tmpdir(), 'create-sdk-url-'))
  tempDirs.push(appDir)
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({ dependencies: { deepspace: 'workspace:*' } }),
  )
  const url = 'https://example.com/commit/deepspace.tgz'
  configurePackageJson(
    appDir,
    'board',
    { name: 'public-board', description: '' },
    '0.42.3',
    undefined,
    { start() {}, stop() {} },
    url,
  )
  expect(
    JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).dependencies.deepspace,
  ).toBe(url)
})
