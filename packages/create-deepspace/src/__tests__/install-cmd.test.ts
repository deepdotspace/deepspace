import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import spawn from 'cross-spawn'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkedInstallCommand, resolveInstall } from '../install-cmd'

const creator = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const npmRange: string = creator.engines.npm

afterEach(() => vi.restoreAllMocks())

describe('resolveInstall', () => {
  it('follows the package manager that invoked the scaffold', () => {
    expect(resolveInstall(true, 'npm/10.8.2 node/v24.0.0 darwin arm64')).toEqual({
      cmd: 'npm',
      args: ['install', '--no-fund', '--no-audit'],
    })
    expect(resolveInstall(false, 'bun/1.2.0')).toEqual({
      cmd: 'bun',
      args: ['install', '--force'],
    })
    expect(resolveInstall(true, 'pnpm/9.0.0 npm/? node/v24.0.0')).toEqual({
      cmd: 'pnpm',
      args: ['install'],
    })
    expect(resolveInstall(true, 'yarn/4.0.0 npm/? node/v24.0.0')).toEqual({
      cmd: 'yarn',
      args: ['install'],
    })
  })

  it('uses bun --force for direct invocations when bun is present (refreshes its stale metadata cache)', () => {
    expect(resolveInstall(true, undefined)).toEqual({ cmd: 'bun', args: ['install', '--force'] })
  })

  it('falls back to npm with the quiet flags when bun is absent', () => {
    expect(resolveInstall(false, undefined)).toEqual({
      cmd: 'npm',
      args: ['install', '--no-fund', '--no-audit'],
    })
  })

  it('ignores an unrecognized user agent', () => {
    expect(resolveInstall(false, 'deno/2.0.0')).toEqual({
      cmd: 'npm',
      args: ['install', '--no-fund', '--no-audit'],
    })
  })
})

describe('checkedInstallCommand', () => {
  const environment = {
    npm_config_user_agent: 'npm/11.17.0 node/v24.20.0',
    npm_execpath: '/selected npm/bin/npm-cli.js',
  }
  const probeResult = (stdout: string) => ({
    pid: 1,
    output: [],
    stdout,
    stderr: '',
    status: 0,
    signal: null,
  })

  it.each(['10.9.2', '10.9.9', '11.5.2', '11.6.0-beta.1', '', 'not-a-version'])(
    'refuses the actual npm version %j, even when the user agent reports a supported npm',
    (version) => {
      vi.spyOn(spawn, 'sync').mockReturnValue(probeResult(version))
      expect(checkedInstallCommand(npmRange, environment)).toMatchObject({
        ok: false,
        error: expect.stringContaining(`requires npm ${npmRange}`),
      })
    },
  )

  it.each(['11.6.0', '11.17.0', '12.0.2'])(
    'accepts %s and keeps installation on the probed executable',
    (version) => {
      const run = vi.spyOn(spawn, 'sync').mockReturnValue(probeResult(`${version}\n`))
      expect(checkedInstallCommand(npmRange, environment)).toEqual({
        ok: true,
        install: {
          cmd: process.execPath,
          args: [environment.npm_execpath, 'install', '--no-fund', '--no-audit'],
          display: 'npm install --no-fund --no-audit',
        },
      })
      expect(run).toHaveBeenLastCalledWith(
        process.execPath,
        [environment.npm_execpath, '--version'],
        expect.objectContaining({ timeout: 10_000 }),
      )
    },
  )

  it('checks PATH npm for a direct invocation without bun', () => {
    const run = vi
      .spyOn(spawn, 'sync')
      .mockReturnValueOnce({ ...probeResult(''), status: 1 })
      .mockReturnValueOnce(probeResult('10.9.9'))
    expect(checkedInstallCommand(npmRange, {})).toMatchObject({ ok: false })
    expect(run).toHaveBeenLastCalledWith('npm', ['--version'], expect.any(Object))
  })

  it.each(['pnpm', 'yarn', 'bun'])('does not apply the npm floor to %s installs', (manager) => {
    const run = vi.spyOn(spawn, 'sync').mockReturnValue(probeResult('10.9.2'))
    expect(
      checkedInstallCommand(npmRange, {
        npm_config_user_agent: `${manager}/1.0.0 npm/?`,
        npm_execpath: `/tools/${manager}.cjs`,
      }),
    ).toMatchObject({ ok: true, install: { cmd: manager } })
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses an unavailable or timed-out npm probe', () => {
    vi.spyOn(spawn, 'sync').mockReturnValue({
      ...probeResult(''),
      status: null,
      error: new Error('spawn ETIMEDOUT'),
    })
    expect(checkedInstallCommand(npmRange, environment)).toMatchObject({
      ok: false,
      error: expect.stringContaining('could not determine the npm version'),
    })
  })

  it('declares the same npm compatibility for generated apps', () => {
    const template = JSON.parse(
      readFileSync(new URL('../../templates/base/package.json', import.meta.url), 'utf8'),
    )
    expect(template.engines.npm).toBe(npmRange)
  })
})

describe('CLI npm compatibility boundary', () => {
  const entry = fileURLToPath(new URL('../index.ts', import.meta.url))
  const tsx = fileURLToPath(
    new URL('../../../../node_modules/tsx/dist/loader.mjs', import.meta.url),
  )

  it.each(['new directory', 'in place'])('refuses old npm before mutating a %s', (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), 'deepspace-old-npm-'))
    try {
      const npmCli = join(directory, 'npm-cli.js')
      writeFileSync(
        npmCli,
        `if (process.argv[2] !== '--version') process.exit(99); console.log('10.9.2')\n`,
      )
      const result = spawnSync(
        process.execPath,
        ['--import', tsx, entry, scenario === 'in place' ? '.' : 'my-app'],
        {
          cwd: directory,
          env: { ...process.env, npm_config_user_agent: 'npm/11.17.0', npm_execpath: npmCli },
          encoding: 'utf8',
          timeout: 15_000,
        },
      )
      expect(result.status, result.stderr).toBe(1)
      expect(result.stderr).toContain('current: 10.9.2')
      expect(result.stderr).toContain('npm install --global npm@11')
      expect(readdirSync(directory)).toEqual(['npm-cli.js'])
      expect(existsSync(join(directory, 'my-app'))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(['--help', '--version'])('keeps %s available when npm cannot run', (flag) => {
    const result = spawnSync(process.execPath, ['--import', tsx, entry, flag], {
      env: {
        ...process.env,
        npm_config_user_agent: 'npm/10.9.2',
        npm_execpath: '/missing/npm-cli.js',
      },
      encoding: 'utf8',
      timeout: 15_000,
    })
    expect(result.status, result.stderr).toBe(0)
  })
})
