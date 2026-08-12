import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import updateCommand, {
  buildPreviewSecretsUpgradeInstruction,
  pinSdkVersion,
  usersSchemaVisibilityUpgradeInstruction,
} from '../update'
import sdkPackage from '../../../../package.json'
import { APP_MIGRATION_DEFINITIONS } from '../update/app-migrations'

describe('app update dependency pinning', () => {
  it('pins an existing direct AI SDK dependency with deepspace', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-update-'))
    const packagePath = join(appDir, 'package.json')
    writeFileSync(
      packagePath,
      JSON.stringify({ dependencies: { ai: '^5.0.0', deepspace: '^0.19.0', react: '^19.0.0' } }),
    )

    expect(pinSdkVersion(appDir, '0.19.1')).toBe(true)
    expect(JSON.parse(readFileSync(packagePath, 'utf8')).dependencies).toEqual({
      ai: '5.0.222',
      deepspace: '^0.19.1',
      react: '^19.0.0',
    })
    expect(pinSdkVersion(appDir, '0.19.1')).toBe(false)
  })

  it('does not add AI when the app does not use it directly', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-update-'))
    const packagePath = join(appDir, 'package.json')
    writeFileSync(packagePath, JSON.stringify({ dependencies: { deepspace: '^0.19.0' } }))

    expect(pinSdkVersion(appDir, '0.19.1')).toBe(true)
    expect(JSON.parse(readFileSync(packagePath, 'utf8')).dependencies).toEqual({
      deepspace: '^0.19.1',
    })
  })

  it('ignores earlier unrelated ai keys and pins only the direct dependency', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-update-'))
    const packagePath = join(appDir, 'package.json')
    writeFileSync(
      packagePath,
      JSON.stringify({
        ai: 'app-metadata',
        config: { ai: 'nested-metadata' },
        devDependencies: { ai: '^6.0.0' },
        dependencies: { deepspace: '^0.19.0', ai: '^5.0.0' },
      }),
    )

    expect(pinSdkVersion(appDir, '0.19.1')).toBe(true)
    expect(JSON.parse(readFileSync(packagePath, 'utf8'))).toEqual({
      ai: 'app-metadata',
      config: { ai: 'nested-metadata' },
      devDependencies: { ai: '^6.0.0' },
      dependencies: { deepspace: '^0.19.1', ai: '5.0.222' },
    })
  })

  it('leaves unrelated ai keys untouched when there is no direct dependency', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-update-'))
    const packagePath = join(appDir, 'package.json')
    writeFileSync(
      packagePath,
      JSON.stringify({ ai: 'app-metadata', dependencies: { deepspace: '^0.19.0' } }),
    )

    expect(pinSdkVersion(appDir, '0.19.1')).toBe(true)
    expect(JSON.parse(readFileSync(packagePath, 'utf8'))).toEqual({
      ai: 'app-metadata',
      dependencies: { deepspace: '^0.19.1' },
    })
  })

  it('preserves common indentation, CRLF, and final-newline formatting', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-update-'))
    const packagePath = join(appDir, 'package.json')
    const source = `${JSON.stringify(
      { dependencies: { deepspace: '^0.19.0', ai: '^5.0.0' } },
      null,
      4,
    ).replaceAll('\n', '\r\n')}\r\n`
    writeFileSync(packagePath, source)

    expect(pinSdkVersion(appDir, '0.19.1')).toBe(true)
    const updated = readFileSync(packagePath, 'utf8')
    expect(updated).toContain('\r\n    "dependencies"')
    expect(updated.replaceAll('\r\n', '')).not.toContain('\n')
    expect(updated.endsWith('\r\n')).toBe(true)
  })
})

describe('app update build-preview guidance', () => {
  it('reports the manual upgrade without rewriting an existing Vite config', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-update-'))
    const configPath = join(appDir, 'vite.config.ts')
    const source = `export default { plugins: [] }\n`
    writeFileSync(configPath, source)

    expect(buildPreviewSecretsUpgradeInstruction(appDir)).toContain(
      `https://github.com/deepdotspace/deepspace/blob/v${sdkPackage.version}/docs/migrations/build-preview-secrets.md`,
    )
    expect(readFileSync(configPath, 'utf8')).toBe(source)
  })

  it('exits with action required when an app-owned retrofit remains', async () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-update-'))
    const logs: string[] = []
    try {
      writeFileSync(
        join(appDir, 'package.json'),
        JSON.stringify({ dependencies: { deepspace: '^0.19.1' } }),
      )
      writeFileSync(join(appDir, 'wrangler.toml'), 'name = "update-test"\n')
      writeFileSync(join(appDir, 'vite.config.ts'), 'export default { plugins: [] }\n')
      writeFileSync(
        join(appDir, 'deepspace.migrations.json'),
        `${JSON.stringify(
          APP_MIGRATION_DEFINITIONS.map(({ id }) => id),
          null,
          2,
        )}\n`,
      )
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: appDir })
      execFileSync('git', ['config', 'user.email', 'update-test@example.com'], { cwd: appDir })
      execFileSync('git', ['config', 'user.name', 'Update Test'], { cwd: appDir })
      execFileSync('git', ['add', '-A'], { cwd: appDir })
      execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: appDir })

      vi.spyOn(process, 'cwd').mockReturnValue(appDir)
      vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
      process.exitCode = undefined
      const command = updateCommand as unknown as {
        run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
      }
      await command.run({ args: { json: true, to: '0.19.2', 'dry-run': false } })

      expect(process.exitCode).toBe(2)
      expect(JSON.parse(logs[0])).toMatchObject({
        ok: false,
        code: 'manual_changes_required',
        actionRequired: true,
        currentVersion: '^0.19.1',
        targetVersion: '0.19.2',
        manualInstructions: [expect.stringContaining('build-preview-secrets.md')],
        action: { cwd: appDir, argv: ['npm', 'install'] },
      })
      expect(JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))).toMatchObject({
        dependencies: { deepspace: '^0.19.2' },
      })
    } finally {
      process.exitCode = undefined
      vi.restoreAllMocks()
      rmSync(appDir, { recursive: true, force: true })
    }
  })

  it('does not report a fresh config that already owns the cleanup', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-update-'))
    writeFileSync(
      join(appDir, 'vite.config.ts'),
      `const plugin = { name: 'deepspace-remove-build-preview-secrets' }\n`,
    )

    expect(buildPreviewSecretsUpgradeInstruction(appDir)).toBeNull()
  })

  it('reports broad member user-row visibility without rewriting the schema', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-update-'))
    const schemaPath = join(appDir, 'src/schemas/users-schema.ts')
    const source = `export const usersSchema = {\n  permissions: {\n    member: { read: true, create: false },\n  },\n}\n`
    mkdirSync(join(appDir, 'src/schemas'), { recursive: true })
    writeFileSync(schemaPath, source)

    expect(usersSchemaVisibilityUpgradeInstruction(appDir)).toContain(
      `https://github.com/deepdotspace/deepspace/blob/v${sdkPackage.version}/docs/migrations/users-schema-member-visibility.md`,
    )
    expect(readFileSync(schemaPath, 'utf8')).toBe(source)
  })

  it("does not report a users schema whose member reads are already 'own'", () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-update-'))
    mkdirSync(join(appDir, 'src/schemas'), { recursive: true })
    writeFileSync(
      join(appDir, 'src/schemas/users-schema.ts'),
      `export const usersSchema = { permissions: { member: { read: 'own' } } }\n`,
    )

    expect(usersSchemaVisibilityUpgradeInstruction(appDir)).toBeNull()
  })
})
