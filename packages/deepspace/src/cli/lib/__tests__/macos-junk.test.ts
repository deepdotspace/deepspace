/**
 * macOS junk sweep: AppleDouble (`._*`) and `.DS_Store` files copied from
 * macOS through tar/zip/SMB hard-fail the deploy lint and can register as
 * generouted routes. The sweep deletes them, leaves everything else alone,
 * and stays out of dependency/build directories.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeMacosJunk } from '../macos-junk'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'macos-junk-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('removeMacosJunk', () => {
  it('removes ._* and .DS_Store files recursively, keeps real files', () => {
    mkdirSync(join(dir, 'src', 'pages'), { recursive: true })
    writeFileSync(join(dir, '.DS_Store'), 'junk')
    writeFileSync(join(dir, 'src', '._app.tsx'), 'junk')
    writeFileSync(join(dir, 'src', 'pages', '._index.tsx'), 'junk')
    writeFileSync(join(dir, 'src', 'pages', 'index.tsx'), 'export default 1')

    expect(removeMacosJunk(dir)).toBe(3)
    expect(existsSync(join(dir, '.DS_Store'))).toBe(false)
    expect(existsSync(join(dir, 'src', '._app.tsx'))).toBe(false)
    expect(existsSync(join(dir, 'src', 'pages', '._index.tsx'))).toBe(false)
    expect(existsSync(join(dir, 'src', 'pages', 'index.tsx'))).toBe(true)
  })

  it('returns 0 on a clean tree', () => {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'index.ts'), 'export {}')
    expect(removeMacosJunk(dir)).toBe(0)
  })

  it('returns 0 instead of throwing on an unreadable directory', () => {
    expect(removeMacosJunk(join(dir, 'does-not-exist'))).toBe(0)
  })

  it('does not descend into node_modules or .git', () => {
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'pkg', '._left-alone'), 'junk')
    writeFileSync(join(dir, '.git', '.DS_Store'), 'junk')

    expect(removeMacosJunk(dir)).toBe(0)
    expect(existsSync(join(dir, 'node_modules', 'pkg', '._left-alone'))).toBe(true)
    expect(existsSync(join(dir, '.git', '.DS_Store'))).toBe(true)
  })
})
