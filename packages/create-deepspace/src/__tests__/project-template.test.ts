import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeGitignoreIfMissing } from '../project-template'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
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
