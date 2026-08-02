import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runInstall } from '../install-worker'

// The worker must be self-sufficient: it opens the log itself and writes its
// own completion/failure sentinel, so a died-silently install is always
// DETECTABLE (never a frozen log with no trace). These exercise that contract
// against a real npm/bun with no network deps (empty/invalid package.json).

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const log = () => join(dir, '.deepspace', 'install.log')

describe('runInstall', () => {
  it('writes install.done and its own log on success (empty deps, no network)', () => {
    dir = mkdtempSync(join(tmpdir(), 'ds-worker-ok-'))
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', version: '0.0.1', private: true, dependencies: {} }) + '\n',
    )
    const code = runInstall(dir, log())
    expect(code).toBe(0)
    expect(existsSync(join(dir, '.deepspace', 'install.done'))).toBe(true)
    expect(existsSync(join(dir, '.deepspace', 'install.err'))).toBe(false)
    // The worker opened and owns the log — it exists even though no parent fd
    // was handed in.
    expect(existsSync(log())).toBe(true)
  }, 60_000)

  it('writes install.err (not done) when the install fails', () => {
    dir = mkdtempSync(join(tmpdir(), 'ds-worker-err-'))
    // Malformed package.json makes npm/bun exit non-zero without any network.
    writeFileSync(join(dir, 'package.json'), '{ not valid json')
    const code = runInstall(dir, log())
    expect(code).toBe(1)
    expect(existsSync(join(dir, '.deepspace', 'install.done'))).toBe(false)
    const err = readFileSync(join(dir, '.deepspace', 'install.err'), 'utf-8')
    expect(err).toMatch(/exited with code|failed to start/)
  }, 60_000)
})
