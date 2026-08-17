/**
 * The preview-`.dev.vars` delete is ONE function with TWO call sites (the
 * `deepspaceBuild()` closeBundle sweep and the deploy CLI's artifact guard).
 * It used to be two implementations, only one of which refused a symlink —
 * these pin the shared safety check and the sweep that now goes through it.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deepspaceBuild, removeBuildDevVars } from '../plugin'

let appDir: string | undefined

afterEach(() => {
  if (appDir) rmSync(appDir, { recursive: true, force: true })
  appDir = undefined
})

function makeApp(): string {
  appDir = mkdtempSync(join(tmpdir(), 'ds-build-dev-vars-'))
  return appDir
}

describe('removeBuildDevVars', () => {
  it('deletes a plain build .dev.vars and reports it', () => {
    const dir = makeApp()
    writeFileSync(join(dir, '.dev.vars'), 'SECRET=1\n')
    expect(removeBuildDevVars(dir)).toBe(true)
    expect(existsSync(join(dir, '.dev.vars'))).toBe(false)
  })

  it('is a no-op when the build emitted none', () => {
    expect(removeBuildDevVars(makeApp())).toBe(false)
  })

  it('refuses a symlinked path instead of following it', () => {
    const dir = makeApp()
    const target = join(dir, 'real-secrets')
    writeFileSync(target, 'SECRET=1\n')
    symlinkSync(target, join(dir, '.dev.vars'))
    expect(() => removeBuildDevVars(dir)).toThrow('Refusing unsafe build secret path')
    expect(existsSync(target)).toBe(true)
  })
})

describe('deepspaceBuild closeBundle sweep', () => {
  it('clears the preview copy beside every built worker', () => {
    const dir = makeApp()
    for (const worker of ['app-worker', 'other-worker']) {
      mkdirSync(join(dir, 'dist', worker), { recursive: true })
      writeFileSync(join(dir, 'dist', worker, '.dev.vars'), 'SECRET=1\n')
    }
    writeFileSync(join(dir, 'dist', 'index.html'), '<html></html>')

    deepspaceBuild({ appDir: dir }).closeBundle()

    expect(existsSync(join(dir, 'dist', 'app-worker', '.dev.vars'))).toBe(false)
    expect(existsSync(join(dir, 'dist', 'other-worker', '.dev.vars'))).toBe(false)
    expect(existsSync(join(dir, 'dist', 'index.html'))).toBe(true)
  })

  it('still clears the dirs after an unsafe one, then reports the unsafe path', () => {
    // 'a-client' sorts before 'b-worker': the symlink must not abort the sweep
    // and leave the plaintext copy behind it in place.
    const dir = makeApp()
    mkdirSync(join(dir, 'dist', 'a-client'), { recursive: true })
    mkdirSync(join(dir, 'dist', 'b-worker'), { recursive: true })
    const outside = join(dir, 'outside-secret')
    writeFileSync(outside, 'SECRET=1\n')
    symlinkSync(outside, join(dir, 'dist', 'a-client', '.dev.vars'))
    writeFileSync(join(dir, 'dist', 'b-worker', '.dev.vars'), 'SECRET=1\n')

    expect(() => deepspaceBuild({ appDir: dir }).closeBundle()).toThrow('Refusing unsafe build secret path')

    expect(existsSync(join(dir, 'dist', 'b-worker', '.dev.vars'))).toBe(false)
    expect(existsSync(outside)).toBe(true)
  })
})
