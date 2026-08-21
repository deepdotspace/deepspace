import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  agentSkillInstallerCommand,
  assertClaudeSkillLinkAvailable,
  ensureClaudeSkillLink,
  installedSdkVersion,
  nextStepsLines,
} from '../setup-runtime'

/**
 * The scaffold names the SDK version it installed, read off disk rather than
 * assumed from the creator's own version — a `--local` tarball or an overridden
 * resolution is exactly the case where the two differ.
 */
describe('installedSdkVersion', () => {
  it('reads the version out of the installed package', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'create-deepspace-sdk-version-'))
    try {
      expect(installedSdkVersion(appDir)).toBeNull()
      mkdirSync(join(appDir, 'node_modules', 'deepspace'), { recursive: true })
      writeFileSync(
        join(appDir, 'node_modules', 'deepspace', 'package.json'),
        JSON.stringify({ name: 'deepspace', version: '0.23.2' }),
      )
      expect(installedSdkVersion(appDir)).toBe('0.23.2')
    } finally {
      rmSync(appDir, { recursive: true, force: true })
    }
  })
})

describe('nextStepsLines', () => {
  const project = { appName: 'demo', isInPlace: false }

  it('omits the login/init recovery pair once the identity registered', () => {
    const lines = nextStepsLines(project, { status: 'registered', plane: 'production' })
    expect(lines).not.toContain('npx deepspace auth login')
    expect(lines).not.toContain('npx deepspace app init')
    expect(lines).toContain('npx deepspace dev start')
  })

  it('lists login AND init together when the scaffold has no identity yet', () => {
    expect(
      nextStepsLines(project, {
        status: 'failed',
        code: 'not_authenticated',
        error: 'Not logged in.',
        plane: 'production',
      }).slice(0, 3),
    ).toEqual([
      'cd demo',
      'npx deepspace auth login',
      'npx deepspace app init',
    ])
  })

  it('offers only `app init` when registration failed for a non-login reason', () => {
    // A quota (or ownership, or network) refusal is not fixed by signing in;
    // telling a signed-in user to `auth login` sent them the wrong way.
    const quota = nextStepsLines(project, {
      status: 'failed',
      code: 'app_quota_exceeded',
      error: 'Active app quota exceeded.',
      plane: 'production',
    })
    expect(quota.slice(0, 2)).toEqual(['cd demo', 'npx deepspace app init'])
    expect(quota).not.toContain('npx deepspace auth login')
  })

  it('offers login + init when registration was skipped or the login was missing', () => {
    expect(nextStepsLines(project, { status: 'skipped' }).slice(1, 3)).toEqual([
      'npx deepspace auth login',
      'npx deepspace app init',
    ])
    expect(
      nextStepsLines(project, {
        status: 'failed',
        code: 'not_authenticated',
        error: 'Not logged in.',
        plane: 'production',
      }).slice(1, 3),
    ).toEqual(['npx deepspace auth login', 'npx deepspace app init'])
  })
})

describe('agentSkillInstallerCommand', () => {
  it('executes npm through the current Node runtime when nested under npm exec', () => {
    expect(agentSkillInstallerCommand({ npm_execpath: '/npm/lib/npm-cli.js' })).toEqual({
      command: process.execPath,
      args: [
        '/npm/lib/npm-cli.js',
        'exec',
        '--yes',
        '--package=skills@latest',
        '--',
        'skills',
        'add',
        'deepdotspace/deepspace-skill',
        '-y',
      ],
    })
  })

  it('uses npm exec directly outside an npm lifecycle', () => {
    expect(agentSkillInstallerCommand({})).toEqual({
      command: 'npm',
      args: [
        'exec',
        '--yes',
        '--package=skills@latest',
        '--',
        'skills',
        'add',
        'deepdotspace/deepspace-skill',
        '-y',
      ],
    })
  })

  it('links Claude to the one portable skill when the destination is free', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-skill-link-'))
    try {
      const source = join(appDir, '.agents', 'skills', 'deepspace')
      const duplicate = join(appDir, '.claude', 'skills', 'deepspace')
      mkdirSync(source, { recursive: true })
      writeFileSync(join(source, 'SKILL.md'), '# Canonical\n')

      ensureClaudeSkillLink(appDir)

      expect(lstatSync(duplicate).isSymbolicLink()).toBe(true)
      if (process.platform !== 'win32') {
        expect(readlinkSync(duplicate)).toBe('../../.agents/skills/deepspace')
      }
    } finally {
      rmSync(appDir, { recursive: true, force: true })
    }
  })

  it('refuses before replacing a user-owned Claude skill directory', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-skill-preserve-'))
    try {
      const source = join(appDir, '.agents', 'skills', 'deepspace')
      const destination = join(appDir, '.claude', 'skills', 'deepspace')
      mkdirSync(source, { recursive: true })
      mkdirSync(destination, { recursive: true })
      writeFileSync(join(source, 'SKILL.md'), '# Canonical\n')
      writeFileSync(join(destination, 'USER-SENTINEL.md'), '# Keep me\n')

      expect(() => assertClaudeSkillLinkAvailable(appDir)).toThrow('it was preserved')
      expect(() => ensureClaudeSkillLink(appDir)).toThrow('refusing to replace it')
      expect(readFileSync(join(destination, 'USER-SENTINEL.md'), 'utf-8')).toBe('# Keep me\n')
      expect(lstatSync(destination).isDirectory()).toBe(true)
    } finally {
      rmSync(appDir, { recursive: true, force: true })
    }
  })
})
