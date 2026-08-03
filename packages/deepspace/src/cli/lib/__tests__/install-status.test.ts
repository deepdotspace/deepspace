import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { installState, resolvesDeepspace } from '../install-status'

describe('resolvesDeepspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-install-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('does not cross from a nested linked worktree into the primary checkout', () => {
    const app = join(root, 'app')
    mkdirSync(app, { recursive: true })
    execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: app })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: app })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: app })
    writeFileSync(join(app, '.gitignore'), 'node_modules\n.deepspace\n')
    writeFileSync(join(app, 'package.json'), '{}\n')
    execFileSync('git', ['add', '.gitignore', 'package.json'], { cwd: app })
    execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: app })

    const worktree = join(app, '.deepspace', 'ws', '01abc')
    execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'ws/test', worktree, 'HEAD'], {
      cwd: app,
    })
    mkdirSync(join(app, 'node_modules', 'deepspace'), { recursive: true })
    writeFileSync(join(app, 'node_modules', 'deepspace', 'package.json'), '{}')

    expect(resolvesDeepspace(app)).toBe(true)
    expect(resolvesDeepspace(worktree)).toBe(false)

    const nestedApp = join(worktree, 'apps', 'web')
    mkdirSync(nestedApp, { recursive: true })
    mkdirSync(join(worktree, 'node_modules', 'deepspace'), { recursive: true })
    writeFileSync(join(worktree, 'node_modules', 'deepspace', 'package.json'), '{}')
    expect(resolvesDeepspace(nestedApp)).toBe(true)
  })

  it('returns false when no ancestor has node_modules/deepspace', () => {
    const bare = join(root, 'bare', 'deep', 'dir')
    mkdirSync(bare, { recursive: true })
    expect(resolvesDeepspace(bare)).toBe(false)
  })

  it('does not treat an unrelated .deepspace directory as an active install', () => {
    const app = join(root, 'markers-only')
    mkdirSync(join(app, '.deepspace'), { recursive: true })
    expect(installState(app)).toBe('missing')
  })

  it('reports explicit install failures', () => {
    const app = join(root, 'failed')
    mkdirSync(join(app, '.deepspace'), { recursive: true })
    writeFileSync(join(app, '.deepspace', 'install.err'), 'failed')
    expect(installState(app)).toBe('failed')
  })
})
