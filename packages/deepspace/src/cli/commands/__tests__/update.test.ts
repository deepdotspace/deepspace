import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pinSdkVersion } from '../update'

describe('app update dependency pinning', () => {
  it('pins an existing direct AI SDK dependency with deepspace', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-update-'))
    const packagePath = join(appDir, 'package.json')
    writeFileSync(
      packagePath,
      JSON.stringify({ dependencies: { ai: '^5.0.0', deepspace: '^0.19.0', react: '^19.0.0' } }),
    )

    expect(pinSdkVersion(appDir, '0.19.1')).toBe(true)
    expect(JSON.parse(readFileSync(packagePath, 'utf8')).dependencies).toEqual({
      ai: '5.0.222',
      deepspace: '^0.19.1',
      react: '^19.0.0',
    })
    expect(pinSdkVersion(appDir, '0.19.1')).toBe(false)
  })

  it('does not add AI when the app does not use it directly', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-update-'))
    const packagePath = join(appDir, 'package.json')
    writeFileSync(packagePath, JSON.stringify({ dependencies: { deepspace: '^0.19.0' } }))

    expect(pinSdkVersion(appDir, '0.19.1')).toBe(true)
    expect(JSON.parse(readFileSync(packagePath, 'utf8')).dependencies).toEqual({
      deepspace: '^0.19.1',
    })
  })
})
