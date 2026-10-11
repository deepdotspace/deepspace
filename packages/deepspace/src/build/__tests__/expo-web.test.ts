import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const exportCalls = vi.hoisted(() => [] as string[][])
vi.mock('node:child_process', () => ({
  // Stands in for `expo export`: writes a page into --output-dir.
  execFileSync: (_command: string, args: string[]) => {
    exportCalls.push(args)
    const out = args[args.indexOf('--output-dir') + 1]
    writeFileSync(join(out, 'index.html'), '<div id="root"></div>')
  },
}))

const { expoWeb } = await import('../expo-web')

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'expo-web-test-'))
  const mobileDir = join(root, 'mobile')
  const outDir = join(root, 'dist', 'client')
  mkdirSync(mobileDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  return { mobileDir, outDir }
}

describe('expoWeb', () => {
  it('runs only for the client build', () => {
    const plugin = expoWeb({ mobileDir: '/nowhere' })
    expect(plugin.applyToEnvironment({ name: 'client' })).toBe(true)
    expect(plugin.applyToEnvironment({ name: 'worker' })).toBe(false)
  })

  it('asks for npm install when the Expo app has no node_modules', () => {
    const { mobileDir, outDir } = dirs()
    expect(() => expoWeb({ mobileDir }).writeBundle({ dir: outDir })).toThrow(/npm install/)
  })

  it('exports with a cleared cache and writes the page and its SPA shell', () => {
    const { mobileDir, outDir } = dirs()
    mkdirSync(join(mobileDir, 'node_modules'))
    expoWeb({ mobileDir }).writeBundle({ dir: outDir })
    expect(exportCalls.at(-1)).toEqual(expect.arrayContaining(['export', '--platform', 'web', '--clear']))
    expect(readFileSync(join(outDir, 'index.html'), 'utf8')).toContain('root')
    expect(readFileSync(join(outDir, '_spa.html'), 'utf8')).toContain('root')
  })
})
