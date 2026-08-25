import type { CommandDef } from 'citty'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineDeepspaceCommand, Refusal } from '../command'
import { assertExecutableAction, cliAction, resolveActionArgv } from '../output'
import { failureEnvelope, withoutReservedKeys } from '../cli-errors'
import { listWorktrees } from '../git/repository'
import { runGit } from '../git/process'

afterEach(() => {
  vi.restoreAllMocks()
  // The runtime records exit codes on process.exitCode now; clear it so a
  // refusal-path test cannot poison the vitest worker's own exit code.
  process.exitCode = undefined
})

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
      const command = defineDeepspaceCommand({
        meta: { name: 'success-action-test', description: 'test only' },
        async run() {
          return { data: {}, action: { cwd: process.cwd(), argv: ['deepspace', 'pull'] } }
        },
      }) as CommandDef & { run: (ctx: { args: Record<string, unknown> }) => Promise<unknown> }
      await command.run({ args: { json: true } })
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
  // The flush contract, inverted: the runtime used to drain stdout and then
  // process.exit(), but on Windows any exit() after a successful built-in
  // fetch() aborts the process (libuv `!(handle->flags & UV_HANDLE_CLOSING)`,
  // src/win/async.c, exit code 0xC0000409) AFTER the result printed. What
  // this pins now: even with a large payload QUEUED on stdout, the runtime
  // never calls process.exit — it records process.exitCode and returns, and
  // Node itself drains the queued pipe write (an active libuv handle) before
  // the loop empties.
  it('records the exit code without process.exit even with queued large JSON', async () => {
    const payload = 'x'.repeat(128 * 1024)
    const fakeStdout = {
      writableLength: payload.length,
      write: vi.fn(() => true),
    }
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(fakeStdout as never)
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
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

    await command.run({ args: { json: true } })
    expect(JSON.parse(logs[0])).toEqual({ ok: true, payload })
    expect(exitSpy).not.toHaveBeenCalled()
    expect(fakeStdout.write).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(0)
  })

  // Regression guard for the Windows fetch-abort: the runtime must never call
  // process.exit on ANY outcome. The refusal path records 2 ("your turn") the
  // same way the success path records 0.
  it('never calls process.exit on the refusal path either', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`)
    }) as never)
    const command = defineDeepspaceCommand({
      meta: { name: 'refusal-exit-test', description: 'test only' },
      async run() {
        throw new Refusal('a local step remains', 'demo_slug', { actionRequired: true })
      },
    }) as CommandDef & {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }

    await command.run({ args: { json: true } })
    expect(exitSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(2)
    expect(JSON.parse(logs[0])).toMatchObject({
      ok: false,
      code: 'demo_slug',
      actionRequired: true,
    })
  })
})

describe('listWorktrees drops entries git still lists but nobody can enter', () => {
  it('omits a worktree whose directory was deleted (prunable), keeps the live ones', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ds-wt-')))
    const repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    runGit(repo, ['init', '--quiet', '-b', 'main'])
    runGit(repo, ['config', 'user.email', 't@example.com'])
    runGit(repo, ['config', 'user.name', 'T'])
    writeFileSync(join(repo, 'f.txt'), 'x')
    runGit(repo, ['add', '.'])
    runGit(repo, ['commit', '--quiet', '-m', 'init'])

    const live = join(root, 'live')
    const dead = join(root, 'dead')
    runGit(repo, ['worktree', 'add', '--quiet', '-b', 'live-branch', live])
    runGit(repo, ['worktree', 'add', '--quiet', '-b', 'dead-branch', dead])
    rmSync(dead, { recursive: true, force: true })

    // git itself still advertises the deleted one until someone prunes.
    expect(
      runGit(repo, ['worktree', 'list', '--porcelain']).stdout.toString('utf-8'),
    ).toContain('dead-branch')

    const usable = listWorktrees(repo)
    expect(usable.map((w) => w.branch)).toContain('live-branch')
    expect(usable.map((w) => w.branch)).not.toContain('dead-branch')
  })
})

describe('withoutReservedKeys guards the envelope', () => {
  it('strips every key the envelope owns', () => {
    // `data`/`extra` can carry raw server JSON, so a payload must never be
    // able to flip a failure to success or inject an unvalidated action.
    // Replacing this function with the identity used to leave the suite green.
    const payload = {
      ok: true,
      code: 'not_the_real_code',
      error: 'not the real error',
      action: { cwd: '/tmp', argv: ['rm', '-rf', '/'] },
      actionRequired: true,
      next: 'x',
      nextAction: 'y',
      resume: 'z',
      usedBytes: 41943040,
      name: 'kept',
    }
    expect(withoutReservedKeys(payload)).toEqual({ usedBytes: 41943040, name: 'kept' })
  })

  it('is what stops a server body overwriting the refusal it is attached to', () => {
    const refusal = new Refusal('The real refusal.', 'repo_full', {
      extra: { ok: true, code: 'spoofed', action: { cwd: '/tmp', argv: ['sh'] }, usedBytes: 1 },
    })
    expect(failureEnvelope(refusal)).toEqual({
      ok: false,
      code: 'repo_full',
      error: 'The real refusal.',
      usedBytes: 1,
    })
  })

  it('keeps an empty payload empty', () => {
    expect(withoutReservedKeys({})).toEqual({})
  })
})
