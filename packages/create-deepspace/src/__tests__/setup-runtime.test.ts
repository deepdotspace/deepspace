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
} from '../setup-runtime'

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
