/**
 * lintProjectSchemas bundles an app's real `src/schemas.ts` with esbuild and
 * runs the server's lintSchema over the exported array — the same findings
 * the worker prints at RecordRoom construction, surfaced at dev/deploy time
 * instead. These tests run the full pipeline against a temp app dir.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintProjectSchemas, formatSchemaLintFindings } from '../schema-lint'

// packages/deepspace root — for symlinking the real package into a temp app.
const PKG_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

const tempDirs: string[] = []

function makeAppDir(schemasSource?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ds-schema-lint-'))
  tempDirs.push(dir)
  if (schemasSource !== undefined) {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'schemas.ts'), schemasSource)
  }
  return dir
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('lintProjectSchemas', () => {
  it('returns null when src/schemas.ts is absent', async () => {
    expect(await lintProjectSchemas(makeAppDir())).toBeNull()
  })

  it('returns null when the file has no schemas array export', async () => {
    const dir = makeAppDir(`export const notSchemas = 42\n`)
    expect(await lintProjectSchemas(dir)).toBeNull()
  })

  it('returns null (not a throw) when the file does not compile, and says lint was skipped', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const dir = makeAppDir(`export const schemas = [ this is not typescript`)
      expect(await lintProjectSchemas(dir)).toBeNull()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0][0])).toContain('Schema lint skipped')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('returns [] for a clean schema', async () => {
    const dir = makeAppDir(`
      export const schemas = [
        {
          name: 'tasks',
          columns: [
            { name: 'title', storage: 'text', required: true },
            { name: 'ownerId', storage: 'text', userBound: true, immutable: true },
          ],
          ownerField: 'ownerId',
          permissions: {
            '*': { read: true, create: true, update: 'own', delete: 'own' },
          },
        },
      ]
    `)
    expect(await lintProjectSchemas(dir)).toEqual([])
  })

  it('surfaces an unenforced visibilityField (the shipping-privacy-bug case)', async () => {
    const dir = makeAppDir(`
      export const schemas = [
        {
          name: 'notes',
          columns: [
            { name: 'body', storage: 'text' },
            { name: 'visibility', storage: 'text' },
          ],
          visibilityField: 'visibility',
          permissions: {
            '*': { read: true, create: true, update: 'own', delete: 'own' },
          },
        },
      ]
    `)
    const findings = await lintProjectSchemas(dir)
    expect(findings).toHaveLength(1)
    expect(findings![0]).toContain('[notes] visibilityField is declared')
  })

  // Pin the shape a freshly scaffolded app actually has: schemas.ts
  // re-exports from sibling src/schemas/*.ts files, and one of those
  // value-imports from 'deepspace/worker' (resolved via the package's
  // exports map to dist/worker.js). This is the case a future esbuild-option
  // change (e.g. packages: 'external') would silently break while the
  // self-contained fixtures above stay green. Needs a built dist/.
  it.skipIf(!existsSync(join(PKG_ROOT, 'dist', 'worker.js')))(
    'lints a starter-shaped app (sibling-file imports + deepspace/worker value import)',
    async () => {
      const dir = makeAppDir()
      mkdirSync(join(dir, 'src', 'schemas'), { recursive: true })
      mkdirSync(join(dir, 'node_modules'), { recursive: true })
      symlinkSync(PKG_ROOT, join(dir, 'node_modules', 'deepspace'), 'dir')
      writeFileSync(
        join(dir, 'src', 'schemas', 'users-schema.ts'),
        `
          import { BASE_USERS_SCHEMA, type CollectionSchema } from 'deepspace/worker'
          export const usersSchema: CollectionSchema = BASE_USERS_SCHEMA
        `,
      )
      writeFileSync(
        join(dir, 'src', 'schemas', 'notes-schema.ts'),
        `
          import type { CollectionSchema } from 'deepspace/worker'
          export const notesSchema: CollectionSchema = {
            name: 'notes',
            columns: [
              { name: 'body', storage: 'text' },
              { name: 'visibility', storage: 'text' },
            ],
            visibilityField: 'visibility',
            permissions: {
              '*': { read: true, create: true, update: 'own', delete: 'own' },
            },
          }
        `,
      )
      writeFileSync(
        join(dir, 'src', 'schemas.ts'),
        `
          import { usersSchema } from './schemas/users-schema'
          import { notesSchema } from './schemas/notes-schema'
          export const schemas = [usersSchema, notesSchema]
        `,
      )
      const findings = await lintProjectSchemas(dir)
      // Non-null proves the bundle+import pipeline handles the real app
      // shape; the one finding proves lint ran over the imported schemas.
      expect(findings).not.toBeNull()
      expect(findings!.filter((f) => f.startsWith('[notes]'))).toHaveLength(1)
    },
  )

  it('collects findings across multiple schemas', async () => {
    const dir = makeAppDir(`
      export const schemas = [
        {
          name: 'posts',
          columns: [
            { name: 'authorId', storage: 'text' },
            { name: 'visibility', storage: 'text' },
          ],
          visibilityField: 'visibility',
          ownerField: 'authorId',
          permissions: { '*': { read: true, create: true, update: 'own', delete: 'own' } },
        },
        {
          name: 'profiles',
          columns: [{ name: 'userId', storage: 'integer', userBound: true }],
          permissions: { '*': { read: true, create: true, update: 'own', delete: 'own' } },
        },
      ]
    `)
    const findings = await lintProjectSchemas(dir)
    // posts: visibilityField unenforced + ownerField not userBound; profiles: userBound non-text
    expect(findings).toHaveLength(3)
    expect(findings!.filter((f) => f.startsWith('[posts]'))).toHaveLength(2)
    expect(findings!.filter((f) => f.startsWith('[profiles]'))).toHaveLength(1)
  })
})

describe('formatSchemaLintFindings', () => {
  it('prints nothing when clean', () => {
    expect(formatSchemaLintFindings([])).toEqual([])
  })

  it('prefixes a count header and bullets each finding', () => {
    const lines = formatSchemaLintFindings(['[a] first', '[b] second'])
    expect(lines[0]).toContain('2 warnings')
    expect(lines[0]).toContain('these ship')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe('  • [a] first')
  })

  it('uses singular grammar for one finding', () => {
    const lines = formatSchemaLintFindings(['[a] only'])
    expect(lines[0]).toContain('1 warning ')
    expect(lines[0]).toContain('this ships')
  })

  it('caps printed findings and collapses the rest to a count', () => {
    const findings = Array.from({ length: 8 }, (_, i) => `[s${i}] finding ${i}`)
    const lines = formatSchemaLintFindings(findings)
    expect(lines[0]).toContain('8 warnings')
    // header + 5 bullets + overflow line
    expect(lines).toHaveLength(7)
    expect(lines[6]).toContain('…and 3 more')
  })
})
