/**
 * Coverage for the `deepspace add` DX fixes (FEAT-3..FEAT-12).
 *
 * The catalog/help/suggest behaviour lives in the shipped `add-feature.cjs`
 * installer, so we exercise it the way the CLI does — by spawning it — rather
 * than mocking. `isDeepSpaceApp` (the FEAT-6 not-an-app guard) is pure and
 * imported directly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isDeepSpaceApp } from '../add'

const here = dirname(fileURLToPath(import.meta.url))
// __tests__ → commands → cli → src → <package root>
const PKG_ROOT = resolve(here, '..', '..', '..', '..')
const SCRIPT = resolve(PKG_ROOT, 'scripts', 'add-feature.cjs')
const STARTER = resolve(PKG_ROOT, '..', 'create-deepspace', 'templates', 'starter')

/** Run the installer from a throwaway cwd (never an installed project). */
function runScript(args: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'ds-addscript-'))
  try {
    const res = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      encoding: 'utf-8',
    })
    return { status: res.status, out: `${res.stdout}${res.stderr}` }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

/** A throwaway copy of the starter template — a real DeepSpace app to install into. */
function makeApp(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'ds-addapp-'))
  const dir = join(root, 'app')
  cpSync(STARTER, dir, { recursive: true })
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** Install a feature into `dir`, returning status + combined output. */
function installInto(dir: string, args: string[], env?: NodeJS.ProcessEnv) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args, dir], {
    encoding: 'utf-8',
    env: env ?? process.env,
  })
  return { status: res.status, out: `${res.stdout}${res.stderr}` }
}

describe('add-feature.cjs help (FEAT-3)', () => {
  const { status, out } = runScript(['--help'])

  it('exits 0', () => expect(status).toBe(0))

  it('shows the public `deepspace add` usage, not the internal script name', () => {
    expect(out).toContain('deepspace add <feature>')
    expect(out).not.toContain('node add-feature.js')
    expect(out).not.toContain('Feature Installation Script')
  })

  it('drops the stale non-existent `items-crud` example', () => {
    expect(out).not.toContain('items-crud')
  })
})

describe('add-feature.cjs --list without an installed project (FEAT-5)', () => {
  const { status, out } = runScript(['--list'])

  it('lists the bundled catalog offline', () => {
    expect(status).toBe(0)
    expect(out).toContain('messaging')
    expect(out).toContain('deepspace add <feature>')
  })
})

describe('add-feature.cjs unknown feature (FEAT-4)', () => {
  it('suggests the closest feature and does not leak an exec error', () => {
    const { status, out } = runScript(['--info', 'messagng'])
    expect(status).toBe(1)
    expect(out).toContain('Unknown feature: messagng')
    expect(out).toContain('Did you mean "messaging"?')
    expect(out).not.toContain('Command failed')
  })
})

describe('add-feature.cjs --info search-bar (FEAT-11)', () => {
  const { status, out } = runScript(['--info', 'search-bar'])

  it('prints human integration steps but not the agent-only guidance', () => {
    expect(status).toBe(0)
    expect(out).toContain('Integration steps')
    // Agent guidance was moved to the non-printed `agentNotes` field.
    expect(out).not.toContain('Ask the user which placement')
  })
})

describe('integrateDependencies cross-section dedupe (FEAT-8/FEAT-12)', () => {
  it('does not duplicate a dep already declared in the sibling section', () => {
    const { dir, cleanup } = makeApp()
    try {
      const pkgPath = join(dir, 'package.json')
      // Pre-seed @types/papaparse in dependencies — the OPPOSITE section from
      // where file-attachments declares it (devDependencies).
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      pkg.dependencies = { ...(pkg.dependencies || {}), '@types/papaparse': '^5.0.0' }
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

      const { status } = installInto(dir, ['file-attachments'])
      expect(status).toBe(0)

      const after = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      // Kept the user's existing declaration, and did NOT re-add it elsewhere.
      expect(after.dependencies['@types/papaparse']).toBe('^5.0.0')
      expect(after.devDependencies?.['@types/papaparse']).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  it('adds a genuinely new dep exactly once', () => {
    const { dir, cleanup } = makeApp()
    try {
      const pkgPath = join(dir, 'package.json')
      const { status } = installInto(dir, ['file-attachments'])
      expect(status).toBe(0)
      const after = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      expect(after.dependencies.papaparse).toBeTruthy()
      expect(after.devDependencies['@types/papaparse']).toBeTruthy()
      expect(after.dependencies['@types/papaparse']).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  it('does not report a name as both added and already-present (same pkg in both sections)', () => {
    // No shipped feature declares the same package in both sections, so exercise
    // the branch with a throwaway feature written into the catalog dir. This is
    // the ONLY case that reaches the dedupe bookkeeping the fix changed, and it
    // asserts on OUTPUT (the fix is console-only; package.json is unaffected).
    const featId = '__dedupe_fixture__'
    const featDir = join(PKG_ROOT, 'features', featId)
    mkdirSync(featDir, { recursive: true })
    writeFileSync(
      join(featDir, 'feature.json'),
      JSON.stringify({
        id: featId,
        name: 'Dedupe fixture',
        category: 'data',
        description: 'test-only',
        details: 'test-only',
        internal: true,
        files: [],
        dependencies: { 'left-pad': '^1.3.0' },
        devDependencies: { 'left-pad': '^1.3.0' },
        instructions: [],
        patterns: [],
      }),
    )
    const { dir, cleanup } = makeApp()
    try {
      const { status, out } = installInto(dir, [featId])
      expect(status).toBe(0)
      // Added once…
      expect(out).toContain('Added to package.json: left-pad')
      // …and NOT also listed as already-present (the pre-fix double-report).
      expect(out).not.toMatch(/Already present.*left-pad/)
      // Landed in exactly one section of package.json.
      const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
      expect(after.dependencies['left-pad']).toBe('^1.3.0')
      expect(after.devDependencies?.['left-pad']).toBeUndefined()
    } finally {
      cleanup()
      rmSync(featDir, { recursive: true, force: true })
    }
  })
})

describe('--install failure handling (FEAT-8)', () => {
  it('reports a launch failure but still prints the manual install footer', () => {
    const { dir, cleanup } = makeApp()
    try {
      // Empty PATH → the package manager can't be spawned (ENOENT). node itself
      // is invoked by absolute path, so the installer still runs.
      const { out } = installInto(dir, ['file-attachments', '--install'], {
        ...process.env,
        PATH: '',
      })
      expect(out).toMatch(/Could not launch \w+/)
      expect(out).toContain('Install new dependencies:')
    } finally {
      cleanup()
    }
  })
})

describe('isDeepSpaceApp (FEAT-6)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ds-addapp-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is true when a wrangler.toml is present', () => {
    writeFileSync(join(dir, 'wrangler.toml'), 'name = "x"\n')
    expect(isDeepSpaceApp(dir)).toBe(true)
  })

  it('is true when package.json declares deepspace', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { deepspace: '^0.5.0' } }))
    expect(isDeepSpaceApp(dir)).toBe(true)
  })

  it('is true when deepspace is only a devDependency', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { deepspace: '^0.5.0' } }))
    expect(isDeepSpaceApp(dir)).toBe(true)
  })

  it('is false for an unrelated directory', () => {
    writeFileSync(join(dir, 'README.md'), '# not an app\n')
    mkdirSync(join(dir, 'src'))
    expect(isDeepSpaceApp(dir)).toBe(false)
  })

  it('is false for a package.json without deepspace', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '^18' } }))
    expect(isDeepSpaceApp(dir)).toBe(false)
  })
})
