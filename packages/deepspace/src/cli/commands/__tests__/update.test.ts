import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sdkPackage from '../../../../package.json'
import updateCommand, {
  gapIsTooWide,
  parseVersion,
  planDependencyGuidance,
  readAppSdkSpec,
} from '../update'
import { APP_MIGRATION_DEFINITIONS } from '../update/app-migrations'

const made: string[] = []

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeApp(
  options: {
    deepspace?: string
    ai?: string
    migrations?: string[]
    packageManager?: string
  } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'deepspace-update-guidance-'))
  made.push(dir)
  const dependencies: Record<string, string> = {
    deepspace: options.deepspace ?? '0.22.0',
  }
  if (options.ai) dependencies.ai = options.ai
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ packageManager: options.packageManager, dependencies }, null, 2) + '\n',
  )
  writeFileSync(join(dir, 'wrangler.toml'), 'name = "update-test"\n')
  if (options.migrations) {
    writeFileSync(join(dir, 'deepspace.migrations.json'), JSON.stringify(options.migrations) + '\n')
  }
  return dir
}

async function runUpdate(appDir: string): Promise<Record<string, unknown>> {
  const logs: string[] = []
  vi.spyOn(process, 'cwd').mockReturnValue(appDir)
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
  const command = updateCommand as unknown as {
    run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
  }
  await command.run({ args: { json: true } })
  return JSON.parse(logs[0]) as Record<string, unknown>
}

describe('app update version authority', () => {
  it('parses ordinary dependency specs and only calls an older forward gap wide', () => {
    expect(parseVersion('^0.22.1')).toEqual({ major: 0, minor: 22, patch: 1 })
    expect(gapIsTooWide(parseVersion('0.11.0')!, parseVersion('0.23.2')!)).toBe(true)
    expect(gapIsTooWide(parseVersion('0.24.0')!, parseVersion('0.23.2')!)).toBe(false)
  })

  it('uses package.json as current state and this CLI package as the only target', () => {
    const dir = makeApp({ deepspace: '^0.22.1', ai: '^5.0.0' })

    expect(readAppSdkSpec(dir)).toBe('^0.22.1')
    expect(planDependencyGuidance(dir)).toEqual([
      { dependency: 'deepspace', from: '^0.22.1', to: sdkPackage.version },
      { dependency: 'ai', from: '^5.0.0', to: sdkPackage.dependencies.ai },
    ])
  })

  it("leaves a local SDK and its AI compatibility under the developer's control", () => {
    const dir = makeApp({ deepspace: 'file:../deepspace.tgz', ai: '^99.0.0' })
    expect(planDependencyGuidance(dir)).toEqual([])
  })

  it('guides published SDK ranges to the exact running CLI version', () => {
    const dir = makeApp({ deepspace: `^${sdkPackage.version}` })
    expect(planDependencyGuidance(dir)).toEqual([
      { dependency: 'deepspace', from: `^${sdkPackage.version}`, to: sdkPackage.version },
    ])
  })
})

describe('app update guidance', () => {
  it('is read-only, requires no Git repository, and names the detected package manager', async () => {
    const dir = makeApp({ packageManager: 'pnpm@11.18.0' })
    mkdirSync(join(dir, 'nested', 'src'), { recursive: true })
    writeFileSync(join(dir, 'nested', 'src', 'constants.ts'), 'legacy unrelated package\n')
    writeFileSync(join(dir, 'src.ts'), 'const untouched = true\n')
    const beforePackage = readFileSync(join(dir, 'package.json'), 'utf8')

    const result = await runUpdate(dir)

    expect(process.exitCode).toBe(0)
    expect(result).toMatchObject({
      ok: true,
      ready: false,
      status: 'guidance_available',
      targetVersion: sdkPackage.version,
      packageManager: 'pnpm',
      writes: [],
    })
    expect(result.action).toBeUndefined()
    expect((result.steps as string[]).some((step) => step === 'Run pnpm install.')).toBe(true)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(beforePackage)
    expect(readFileSync(join(dir, 'nested', 'src', 'constants.ts'), 'utf8')).toBe(
      'legacy unrelated package\n',
    )
    expect(() => readFileSync(join(dir, 'deepspace.migrations.json'))).toThrow()
  })

  it('does not stamp a partial app-id adoption as complete', async () => {
    const dir = makeApp({ deepspace: sdkPackage.version })
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'src', 'constants.ts'),
      'declare const __DEEPSPACE_APP_ID__: string\nexport const APP_ID = __DEEPSPACE_APP_ID__\n',
    )

    const result = await runUpdate(dir)

    expect(result).toMatchObject({
      ok: true,
      ready: false,
      status: 'guidance_available',
      writes: [],
    })
    expect((result.migrations as Array<{ id: string }>).map(({ id }) => id)).toContain(
      '2026-08-build-injected-app-id',
    )
    expect(() => readFileSync(join(dir, 'deepspace.migrations.json'))).toThrow()
  })

  it('reports ready only when dependencies and the migration ledger are aligned', async () => {
    const dir = makeApp({
      deepspace: sdkPackage.version,
      ai: sdkPackage.dependencies.ai,
      migrations: APP_MIGRATION_DEFINITIONS.map(({ id }) => id),
    })

    const result = await runUpdate(dir)

    expect(process.exitCode).toBe(0)
    expect(result).toMatchObject({
      ok: true,
      ready: true,
      status: 'aligned',
      targetVersion: sdkPackage.version,
      dependencies: [],
      migrations: [],
      steps: [],
      writes: [],
    })
  })

  it('reports a local or VCS SDK as unverified instead of aligned', async () => {
    const dir = makeApp({
      deepspace: 'workspace:*',
      ai: '^99.0.0',
      migrations: APP_MIGRATION_DEFINITIONS.map(({ id }) => id),
    })

    const result = await runUpdate(dir)

    expect(result).toMatchObject({
      ok: true,
      ready: false,
      status: 'dependency_unverified',
      dependencies: [],
      migrations: [],
      manualInstructions: [expect.stringContaining('cannot verify which SDK version')],
      steps: [expect.stringContaining('cannot verify which SDK version')],
      writes: [],
    })
    expect(process.exitCode).toBe(0)
  })

  it('gives a malformed migration ledger a stable refusal code', async () => {
    const dir = makeApp({ deepspace: sdkPackage.version })
    writeFileSync(join(dir, 'deepspace.migrations.json'), '{not json}\n')

    const result = await runUpdate(dir)

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_migration_manifest',
      error: expect.stringContaining('must contain valid JSON'),
    })
    expect(process.exitCode).toBe(1)
  })

  it('guides without failing when the app is newer than the running CLI', async () => {
    const dir = makeApp({ deepspace: '99.0.0' })
    const result = await runUpdate(dir)
    expect(result).toMatchObject({ ok: true, ready: false, status: 'cli_version_behind' })
    expect(process.exitCode).toBe(0)
  })

  it('guides release-by-release without failing on a wide version gap', async () => {
    const dir = makeApp({ deepspace: '0.11.0' })
    const result = await runUpdate(dir)
    expect(result).toMatchObject({ ok: true, ready: false, status: 'version_gap_too_wide' })
    expect(result.steps).toEqual([expect.stringContaining('one at a time')])
    expect(process.exitCode).toBe(0)
  })
})
