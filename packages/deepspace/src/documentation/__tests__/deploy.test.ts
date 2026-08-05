import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readDocumentationDeployManifest } from '../deploy'

function fixture(): { appDir: string; clientDir: string } {
  const appDir = mkdtempSync(join(tmpdir(), 'deepspace-documentation-deploy-'))
  const clientDir = join(appDir, 'dist', 'client')
  mkdirSync(clientDir, { recursive: true })
  return { appDir, clientDir }
}

describe('documentation deploy manifest boundary', () => {
  it('is inert when the feature is absent', () => {
    const { appDir, clientDir } = fixture()
    expect(readDocumentationDeployManifest(appDir, clientDir)).toBeUndefined()
  })

  it('fails by name when the feature exists but the build compiled nothing', () => {
    const { appDir, clientDir } = fixture()
    writeFileSync(join(appDir, 'documentation.json'), '{}')
    expect(() => readDocumentationDeployManifest(appDir, clientDir)).toThrow(
      /deepSpaceDocumentation\(\)/,
    )
  })

  it('returns the manifest the Vite build compiled into the asset tree', () => {
    const { appDir, clientDir } = fixture()
    writeFileSync(join(appDir, 'documentation.json'), '{}')
    mkdirSync(join(clientDir, '_documentation'), { recursive: true })
    writeFileSync(
      join(clientDir, '_documentation', 'manifest.json'),
      JSON.stringify({ pageCount: 3, domains: [] }),
    )
    expect(readDocumentationDeployManifest(appDir, clientDir)).toMatchObject({ pageCount: 3 })
  })
})
