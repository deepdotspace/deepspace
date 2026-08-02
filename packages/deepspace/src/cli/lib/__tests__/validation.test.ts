/**
 * The validation machinery behind `workspace land --validate`: command
 * resolution and the runner (a failed check still returns a well-formed result
 * — the caller turns it into a refusal, it never throws).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveValidationCommand, runValidationCommand } from '../validation'

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

const mkdir = (): string => {
  dir = mkdtempSync(join(tmpdir(), 'ds-validate-'))
  return dir
}

describe('runValidationCommand', () => {
  it('captures a passing command', () => {
    const run = runValidationCommand(mkdir(), 'echo hello && exit 0')
    expect(run.passed).toBe(true)
    expect(run.exitStatus).toBe(0)
    expect(run.output).toContain('hello')
    expect(run.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('captures a failing command WITHOUT throwing (advisory), keeping its output', () => {
    const run = runValidationCommand(mkdir(), 'echo boom 1>&2 && exit 3')
    expect(run.passed).toBe(false)
    expect(run.exitStatus).toBe(3)
    expect(run.output).toContain('boom')
    expect(run.summary).toContain('boom')
  })
})

describe('resolveValidationCommand', () => {
  it('prefers an explicit command (trimmed)', () => {
    expect(resolveValidationCommand(mkdir(), '  vitest run  ')).toBe('vitest run')
  })

  it('falls back to the package.json validate script (npm by default)', () => {
    const d = mkdir()
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { validate: 'vitest run' } }))
    expect(resolveValidationCommand(d)).toBe('npm run --silent validate')
  })

  it('returns null when there is no explicit command and no validate script', () => {
    expect(resolveValidationCommand(mkdir())).toBeNull()
  })
})
