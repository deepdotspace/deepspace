import type { CommandDef } from 'citty'
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineDeepspaceCommand, Refusal } from '../command'
import { assertExecutableAction, cliAction, resolveActionArgv } from '../output'

afterEach(() => vi.restoreAllMocks())

/** A throwaway package tree: <root>/node_modules/<name>/dist/cli.js + a bin symlink. */
function fakeCliInstall(packageName: string): { entry: string; binLink: string } {
  // realpath: on macOS /var is itself a symlink, and the pinning resolves it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ds-entry-')))
  const pkgDir = join(root, 'node_modules', packageName)
  mkdirSync(join(pkgDir, 'dist'), { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: packageName }))
  const entry = join(pkgDir, 'dist', 'cli.js')
  writeFileSync(entry, '#!/usr/bin/env node\n')
  const binDir = join(root, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  const binLink = join(binDir, packageName)
  symlinkSync(entry, binLink)
  return { entry, binLink }
}

describe('structured CLI actions', () => {
  it('preserves executable argv as data and binds it to an absolute cwd', () => {
    expect(cliAction('deepspace', 'pull')).toEqual({
      cwd: process.cwd(),
      argv: ['deepspace', 'pull'],
    })
  })

  describe('pinning a `deepspace` action to the running CLI', () => {
    it('pins through the bin symlink so the action runs where no `deepspace` is on PATH', () => {
      const { entry, binLink } = fakeCliInstall('deepspace')
      vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', binLink])
      expect(resolveActionArgv(['deepspace', 'workspace', 'land'])).toEqual([
        process.execPath,
        entry,
        'workspace',
        'land',
      ])
    })

    it('applies to actions built as object literals, not just cliAction()', () => {
      const { entry, binLink } = fakeCliInstall('deepspace')
      vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', binLink])
      const refusal = new Refusal('nope', 'slug', {
        action: { cwd: process.cwd(), argv: ['deepspace', 'pull'] },
      })
      expect(refusal.action?.argv).toEqual([process.execPath, entry, 'pull'])
    })

    it("leaves another package's cli.js alone — an embedder must not be handed our arguments", () => {
      const { entry } = fakeCliInstall('some-other-tool')
      vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', entry])
      expect(resolveActionArgv(['deepspace', 'pull'])).toEqual(['deepspace', 'pull'])
    })

    it('pins success-path actions through the command runtime', async () => {
      const { entry, binLink } = fakeCliInstall('deepspace')
      vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', binLink])
      const logs: string[] = []
      vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit:${code ?? 0}`)
      }) as never)
      const command = defineDeepspaceCommand({
        meta: { name: 'success-action-test', description: 'test only' },
        async run() {
          return { data: {}, action: { cwd: process.cwd(), argv: ['deepspace', 'pull'] } }
        },
      }) as CommandDef & { run: (ctx: { args: Record<string, unknown> }) => Promise<unknown> }
      await expect(command.run({ args: { json: true } })).rejects.toThrow('exit:0')
      expect(JSON.parse(logs[0]).action.argv).toEqual([process.execPath, entry, 'pull'])
    })

    it('leaves non-deepspace argv, relative entries, and unidentifiable entries alone', () => {
      const { entry } = fakeCliInstall('deepspace')
      vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', entry])
      expect(resolveActionArgv(['git', 'checkout', 'main'])).toEqual(['git', 'checkout', 'main'])

      vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'dist/cli.js'])
      expect(resolveActionArgv(['deepspace', 'pull'])).toEqual(['deepspace', 'pull'])

      vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', join(tmpdir(), 'gone-cli.js')])
      expect(resolveActionArgv(['deepspace', 'pull'])).toEqual(['deepspace', 'pull'])
    })
  })

  it('rejects placeholders because an agent cannot execute them verbatim', () => {
    expect(() => cliAction('deepspace', 'app', 'create', '<name>')).toThrow(/placeholder/)
  })

  it('rejects relative working directories and empty executables', () => {
    expect(() => assertExecutableAction({ cwd: '.', argv: ['git', 'status'] })).toThrow(/absolute/)
    expect(() => assertExecutableAction({ cwd: process.cwd(), argv: [] })).toThrow(/executable/)
  })
})

describe('shared command output', () => {
  it('flushes queued large JSON before exiting', async () => {
    const payload = 'x'.repeat(128 * 1024)
    const writes: string[] = []
    const fakeStdout = {
      writableLength: payload.length,
      write: vi.fn((chunk: string, callback: () => void) => {
        writes.push(chunk)
        callback()
        return true
      }),
    }
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(fakeStdout as never)
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
    const exits: number[] = []
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code ?? 0)
      throw new Error(`exit:${code ?? 0}`)
    }) as never)
    const command = defineDeepspaceCommand({
      meta: { name: 'large-output-test', description: 'test only' },
      async run() {
        return { data: { payload } }
      },
    }) as CommandDef & {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }

    await expect(command.run({ args: { json: true } })).rejects.toThrow('exit:0')
    expect(JSON.parse(logs[0])).toEqual({ ok: true, payload })
    expect(writes).toEqual([''])
    expect(exits).toEqual([0])
  })
})
