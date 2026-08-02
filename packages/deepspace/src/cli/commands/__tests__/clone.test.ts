/**
 * Failed-clone cleanup for a PRE-EXISTING target dir: git only removes clone
 * dirs it created, so the CLI reaps the partial transfer itself — but only
 * the unambiguous `.git`-only debris; anything else is reported, never
 * deleted.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanFailedCloneDir, validateCloneTarget } from '../clone'

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'ds-clone-clean-'))
}

describe('cleanFailedCloneDir', () => {
  it('removes a lone .git leftover (the mid-transfer failure signature)', () => {
    const dir = makeDir()
    try {
      mkdirSync(join(dir, '.git', 'objects'), { recursive: true })
      writeFileSync(join(dir, '.git', 'config'), '[core]\n')
      expect(cleanFailedCloneDir(dir)).toEqual([])
      expect(existsSync(join(dir, '.git'))).toBe(false)
      expect(readdirSync(dir)).toEqual([]) // dir itself survives — the user made it
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves and reports anything beyond .git (a partial checkout, a concurrent writer)', () => {
    const dir = makeDir()
    try {
      mkdirSync(join(dir, '.git'), { recursive: true })
      writeFileSync(join(dir, 'half-checked-out.txt'), 'partial\n')
      const leftovers = cleanFailedCloneDir(dir)
      expect(leftovers.sort()).toEqual(['.git', 'half-checked-out.txt'])
      // Nothing was deleted.
      expect(existsSync(join(dir, '.git'))).toBe(true)
      expect(existsSync(join(dir, 'half-checked-out.txt'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a quiet no-op when the dir is gone (git cleaned up after itself)', () => {
    const dir = join(makeDir(), 'never-created')
    expect(cleanFailedCloneDir(dir)).toEqual([])
  })

  it('reports nothing for an empty dir (nothing landed before the failure)', () => {
    const dir = makeDir()
    try {
      expect(cleanFailedCloneDir(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('validateCloneTarget', () => {
  it('accepts a missing or empty directory and reports whether it pre-existed', () => {
    const parent = makeDir()
    const missing = join(parent, 'missing')
    const empty = join(parent, 'empty')
    mkdirSync(empty)
    try {
      expect(validateCloneTarget(missing)).toBe(false)
      expect(validateCloneTarget(empty)).toBe(true)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('refuses an existing file with the stable dir_exists code', () => {
    const parent = makeDir()
    const file = join(parent, 'target')
    writeFileSync(file, 'not a directory\n')
    try {
      expect(() => validateCloneTarget(file)).toThrow(
        expect.objectContaining({
          code: 'dir_exists',
          message: expect.stringContaining('not a directory'),
        }),
      )
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('refuses a non-empty directory with the stable dir_exists code', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'keep.txt'), 'keep\n')
    try {
      expect(() => validateCloneTarget(dir)).toThrow(
        expect.objectContaining({
          code: 'dir_exists',
          message: expect.stringContaining('not empty'),
        }),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
