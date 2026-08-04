import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resetNativeDocsOutput } from '../deploy/build'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

describe('native docs deploy output', () => {
  it('removes stale development docs before collecting a docs-disabled release', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-docs-disabled-'))
    fixtures.push(appDir)
    const clientDir = join(appDir, 'dist', 'client')
    const staleDocsDir = join(clientDir, '_docs')
    mkdirSync(staleDocsDir, { recursive: true })
    writeFileSync(join(staleDocsDir, 'manifest.json'), '{"stale":true}')

    expect(resetNativeDocsOutput(clientDir)).toBe(staleDocsDir)
    expect(existsSync(staleDocsDir)).toBe(false)
  })
})
