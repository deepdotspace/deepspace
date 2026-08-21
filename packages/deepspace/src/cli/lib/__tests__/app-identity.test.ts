/**
 * `readAppId` tells ABSENT (no id yet — `app init` heals it) from MALFORMED
 * (an id-shaped slot holding something that is not an id). Conflating them
 * sent every command's `app init` recovery off to mint a fresh id over the
 * malformed one, orphaning the app the directory belonged to.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAppId, writeAppId } from '../app-identity'
import { errorCode } from '../cli-errors'

const VALID = 'app_01JG8QK4M2N7P9RSTVWXYZ0123'
const OTHER = 'app_01JG8QK4M2N7P9RSTVWXYZ0456'

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function app(lines: string[]): string {
  dir = mkdtempSync(join(tmpdir(), 'ds-app-identity-'))
  writeFileSync(join(dir, 'wrangler.toml'), lines.join('\n') + '\n')
  return dir
}

const thrown = (fn: () => unknown): unknown => {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

describe('readAppId', () => {
  it('absent: no key, or the scaffold placeholder → null', () => {
    expect(readAppId(app(['name = "x"']))).toBeNull()
    expect(readAppId(app(['name = "x"', '[vars]', 'DEEPSPACE_APP_ID = "__APP_ID__"']))).toBeNull()
    expect(readAppId(app(['name = "x"', '[vars]', `DEEPSPACE_APP_ID = "${VALID}"`]), 'staging')).toBeNull()
  })

  it('malformed: present but not an id → invalid_app_id naming the value and the section', () => {
    for (const value of ['"not-an-app-id"', '""', '"app_short"', '42']) {
      const err = thrown(() => readAppId(app(['name = "x"', '[vars]', `DEEPSPACE_APP_ID = ${value}`])))
      expect(errorCode(err), value).toBe('invalid_app_id')
      expect((err as Error).message, value).toContain('[vars] DEEPSPACE_APP_ID = ' + (value === '42' ? '42' : value))
      expect((err as Error).message).toMatch(/server-minted/)
      expect((err as Error).message).toContain('--new-id')
    }
    const err = thrown(() =>
      readAppId(app(['name = "x"', '[env.staging.vars]', 'DEEPSPACE_APP_ID = "nope"']), 'staging'),
    )
    expect(errorCode(err)).toBe('invalid_app_id')
    expect((err as Error).message).toContain('[env.staging.vars]')
  })

  it('valid → the id', () => {
    expect(readAppId(app(['name = "x"', '[vars]', `DEEPSPACE_APP_ID = "${VALID}"`]))).toBe(VALID)
  })
})

describe('writeAppId', () => {
  it('refuses to overwrite a malformed value without force — the same refusal readers give', () => {
    const cwd = app(['name = "x"', '[vars]', 'DEEPSPACE_APP_ID = "not-an-app-id"'])
    expect(errorCode(thrown(() => writeAppId(cwd, VALID)))).toBe('invalid_app_id')
    expect(readFileSync(join(cwd, 'wrangler.toml'), 'utf-8')).toContain('"not-an-app-id"')
  })

  it('force (--new-id) replaces a malformed value in place', () => {
    const cwd = app(['name = "x"', '[vars]', 'DEEPSPACE_APP_ID = "not-an-app-id"', 'APP_NAME = "x"'])
    writeAppId(cwd, VALID, { force: true })
    const src = readFileSync(join(cwd, 'wrangler.toml'), 'utf-8')
    expect(src).toContain(`DEEPSPACE_APP_ID = "${VALID}"`)
    expect(src).not.toContain('not-an-app-id')
    expect(src).toContain('APP_NAME = "x"')
    expect(readAppId(cwd)).toBe(VALID)
  })

  it('still refuses to overwrite a valid id without force, and is a no-op for the same id', () => {
    const cwd = app(['name = "x"', '[vars]', `DEEPSPACE_APP_ID = "${VALID}"`])
    expect(() => writeAppId(cwd, OTHER)).toThrow(/immutable/)
    expect(() => writeAppId(cwd, VALID)).not.toThrow()
    writeAppId(cwd, OTHER, { force: true })
    expect(readAppId(cwd)).toBe(OTHER)
  })
})
