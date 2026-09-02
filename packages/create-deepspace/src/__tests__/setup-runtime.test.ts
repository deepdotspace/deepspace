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

/**
 * Every scaffold now leaves here identity-less — nothing is registered during
 * `npm create`, logged in or not — so Next steps has no registration branch
 * left to take. What it MUST still carry is the ownership fact: the app is
 * claimed by whichever login the shell holds when the first id-needing verb
 * runs, which is no longer necessarily the shell that scaffolded it.
 */
describe('nextStepsLines', () => {
  const project = { appName: 'demo', isInPlace: false }

  it('never lists registration as a step of its own', () => {
    const lines = nextStepsLines(project)
    expect(lines).not.toContain('npx deepspace app init')
    // `auth login` is named inside the ownership note, never as a command an
    // already-signed-in user is told to run.
    expect(lines).not.toContain('npx deepspace auth login')
    expect(lines.slice(0, 1)).toEqual(['cd demo'])
    expect(lines).toContain('npx deepspace dev start')
    expect(lines).toContain('  npx deepspace deploy')
  })

  it('says which account first use will register the app to', () => {
    const note = nextStepsLines(project).join('\n')
    expect(note).toContain('registers this app')
    expect(note).toContain('npx deepspace auth login')
  })

  it('drops the cd line when scaffolding in place', () => {
    expect(nextStepsLines({ appName: 'demo', isInPlace: true })[0]).not.toContain('cd ')
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
        '--agent',
        'codex',
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
        '--agent',
        'codex',
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
