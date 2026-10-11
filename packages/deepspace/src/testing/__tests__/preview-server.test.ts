import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { testState } from '../../build/test-state'
import { builtWorkerDir, previewVars } from '../preview-server'

describe('servePreview pieces', () => {
  it('finds the built Worker beside the client assets', () => {
    const app = mkdtempSync(join(tmpdir(), 'preview-'))
    mkdirSync(join(app, 'dist', 'client'), { recursive: true })
    mkdirSync(join(app, 'dist', 'my_app'), { recursive: true })
    writeFileSync(join(app, 'dist', 'my_app', 'wrangler.json'), '{}')
    expect(builtWorkerDir(app)).toBe(join(app, 'dist', 'my_app'))
    expect(() => builtWorkerDir(mkdtempSync(join(tmpdir(), 'preview-')))).toThrow(/vite build/)
  })

  it('makes the test account the owner and keeps every other variable', () => {
    const vars = 'AUTH_JWT_ISSUER=x\nOWNER_USER_ID=real-owner\nAPP_NAME=y\n'
    expect(previewVars(vars, 'tester')).toBe('AUTH_JWT_ISSUER=x\nAPP_NAME=y\nOWNER_USER_ID=tester\n')
    expect(previewVars(vars)).toBe(vars)
  })

  it('points the Worker at the run’s own state directory only when one is set', () => {
    expect(testState({ DEEPSPACE_TEST_STATE_DIR: '/tmp/run' })).toEqual({ persistState: { path: '/tmp/run' } })
    expect(testState({})).toBeUndefined()
  })
})
