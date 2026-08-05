/**
 * Coverage for the typed `deepspace add` catalog and installer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseToml } from 'smol-toml'

import addCommand, {
  isDeepSpaceApp,
  renderFeatureHelp,
  renderFeatureInfo,
  renderFeatureList,
} from '../add'
import {
  installFeature,
  readFeatureConfig,
  suggestFeature,
  type FeatureInstallOutcome,
} from '../feature-installer'
import { assembleTemplate } from './template-assembly'

const here = dirname(fileURLToPath(import.meta.url))
// __tests__ → commands → cli → src → <package root>
const PKG_ROOT = resolve(here, '..', '..', '..', '..')

/** A throwaway starter app (base + starter overlay) — a real DeepSpace app to install into. */
function makeApp(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'ds-addapp-'))
  const dir = join(root, 'app')
  assembleTemplate('starter', dir)
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** Link this package as the app's installed deepspace dependency. */
function linkInstalledPackage(dir: string): void {
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  symlinkSync(
    PKG_ROOT,
    join(dir, 'node_modules', 'deepspace'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
}

async function runAddJson(
  dir: string,
  feature: string,
  install = false,
  linkPackage = true,
): Promise<Record<string, unknown>> {
  if (linkPackage) linkInstalledPackage(dir)
  const { exitCode, result } = await invokeAddJson({
    feature,
    dir,
    install,
    list: false,
  })
  expect(exitCode).toBe(0)
  return result
}

async function invokeAddJson(
  args: Record<string, unknown>,
): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  const logs: string[] = []
  let exitCode: number | undefined
  const logSpy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
    logs.push(String(line))
  })
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0
    throw new Error(`exit:${exitCode}`)
  }) as never)
  const command = addCommand as unknown as {
    run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
  }

  try {
    await command.run({ args: { ...args, json: true } }).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.startsWith('exit:')) throw error
    })
    expect(exitCode).toBeDefined()
    expect(logs).toHaveLength(1)
    return {
      exitCode: exitCode!,
      result: JSON.parse(logs[0]) as Record<string, unknown>,
    }
  } finally {
    exitSpy.mockRestore()
    logSpy.mockRestore()
  }
}

/** Run the typed installer directly and collect its human progress output. */
function installInto(
  dir: string,
  args: string[],
): { status: number; out: string; outcome: FeatureInstallOutcome } {
  const lines: string[] = []
  const outcome = installFeature({
    feature: args[0],
    targetDir: dir,
    installDependencies: args.includes('--install'),
    emit: (line) => lines.push(line),
  })
  return { status: outcome.ok ? 0 : 1, out: lines.join('\n'), outcome }
}

describe('typed feature catalog help (FEAT-3)', () => {
  it('shows the public `deepspace add` usage, not the internal script name', () => {
    const out = renderFeatureHelp(PKG_ROOT)
    expect(out).toContain('deepspace add <feature>')
    expect(out).not.toContain('node add-feature.js')
    expect(out).not.toContain('Feature Installation Script')
  })

  it('drops the stale non-existent `items-crud` example', () => {
    const out = renderFeatureHelp(PKG_ROOT)
    expect(out).not.toContain('items-crud')
  })

  it('renders known categories first and unknown categories alphabetically', () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-feature-categories-'))
    const writeFeature = (id: string, category: string): void => {
      const featureDir = join(root, 'features', id)
      mkdirSync(featureDir, { recursive: true })
      writeFileSync(
        join(featureDir, 'feature.json'),
        JSON.stringify({ id, name: id, category, description: id, files: [] }),
      )
    }
    try {
      writeFeature('assistant-one', 'assistant')
      writeFeature('data-one', 'data')
      writeFeature('zeta-one', 'zeta')
      writeFeature('commerce-one', 'commerce')

      for (const output of [renderFeatureHelp(root), renderFeatureList(root)]) {
        expect(output).toContain('commerce-one')
        expect(output).toContain('zeta-one')
        expect(output.indexOf('assistant-one')).toBeLessThan(output.indexOf('data-one'))
        expect(output.indexOf('data-one')).toBeLessThan(output.indexOf('commerce-one'))
        expect(output.indexOf('commerce-one')).toBeLessThan(output.indexOf('zeta-one'))
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('typed feature catalog list without an installed project (FEAT-5)', () => {
  it('lists the bundled catalog offline', async () => {
    const out = renderFeatureList(PKG_ROOT)
    expect(out).toContain('messaging')
    expect(out).toContain('deepspace add <feature>')

    const { exitCode, result } = await invokeAddJson({ list: true })
    expect(exitCode).toBe(0)
    expect(result).toMatchObject({
      ok: true,
      features: expect.arrayContaining([expect.objectContaining({ id: 'messaging' })]),
    })
  })
})

describe('typed feature catalog unknown feature (FEAT-4)', () => {
  it('suggests the closest feature and does not leak an exec error', async () => {
    expect(suggestFeature('messagng', PKG_ROOT)).toBe('messaging')
    const { exitCode, result } = await invokeAddJson({ info: 'messagng' })
    expect(exitCode).toBe(1)
    expect(result).toMatchObject({
      ok: false,
      code: 'unknown_feature',
      action: { argv: ['deepspace', 'add', '--list'] },
    })
    expect(result.error).toContain('Did you mean "messaging"?')
    expect(result.error).not.toContain('Command failed')
  })

  it('returns the target catalog facts without pointing at the running catalog', () => {
    const outcome = installFeature({
      feature: 'messagng',
      targetDir: PKG_ROOT,
      installDependencies: false,
    })
    expect(outcome).toMatchObject({
      ok: false,
      code: 'unknown_feature',
      data: {
        requestedFeature: 'messagng',
        suggestedFeature: 'messaging',
        availableFeatures: expect.arrayContaining([expect.objectContaining({ id: 'messaging' })]),
      },
    })
    if (!outcome.ok) expect(outcome.error).not.toContain('add --list')
  })
})

describe('typed feature catalog info (FEAT-11)', () => {
  it('prints human integration steps but not the agent-only guidance', () => {
    const config = readFeatureConfig('search-bar', PKG_ROOT)
    expect(config).not.toBeNull()
    const out = renderFeatureInfo(config!)
    expect(out).toContain('Integration steps')
    // Agent guidance was moved to the non-printed `agentNotes` field.
    expect(out).not.toContain('Ask the user which placement')
  })
})

describe('feature-owned dependencies', () => {
  it('installs the landing page animation dependency only with the landing feature', () => {
    const { dir, cleanup } = makeApp()
    try {
      const pkgPath = join(dir, 'package.json')
      const before = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      expect(before.dependencies['framer-motion']).toBeUndefined()

      const { status } = installInto(dir, ['landing'])
      expect(status).toBe(0)

      const after = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      expect(after.dependencies['framer-motion']).toBe('^12.38.0')
      expect(existsSync(join(dir, 'src/pages/(app)/landing.tsx'))).toBe(true)
    } finally {
      cleanup()
    }
  })
})

describe('documents feature assembly', () => {
  it('uses the public Yjs hook without installing a feature-owned fork', () => {
    const { dir, cleanup } = makeApp()
    try {
      const { status } = installInto(dir, ['documents'])
      expect(status).toBe(0)

      const page = readFileSync(
        join(dir, 'src/pages/(app)/(protected)/documents/[docId].tsx'),
        'utf-8',
      )
      expect(page).toContain('useYjsRoom')
      expect(page).toContain("from 'deepspace'")
      expect(page).not.toContain('useYjsRoomWithAwareness')
      expect(
        existsSync(
          join(dir, 'src/pages/(app)/(protected)/documents/use-yjs-room-with-awareness.ts'),
        ),
      ).toBe(false)
    } finally {
      cleanup()
    }
  })
})

describe('documentation feature assembly', () => {
  it('enables /docs with config and Markdown without adding an application route', () => {
    const { dir, cleanup } = makeApp()
    try {
      const navPath = join(dir, 'src/nav.ts')
      const navBefore = readFileSync(navPath, 'utf-8')
      const { status } = installInto(dir, ['documentation'])

      expect(status).toBe(0)
      expect(JSON.parse(readFileSync(join(dir, 'documentation.json'), 'utf-8'))).toMatchObject({
        name: 'Documentation',
        domains: [],
      })
      expect(readFileSync(join(dir, 'documentation/index.mdx'), 'utf-8')).toContain(
        'This site is compiled from Markdown and MDX',
      )
      expect(readFileSync(join(dir, 'documentation/index.mdx'), 'utf-8')).not.toContain('\n# ')
      expect(readFileSync(navPath, 'utf-8')).toBe(navBefore)
      expect(readFileSync(join(dir, 'vite.config.ts'), 'utf-8')).toContain(
        'deepSpaceDocumentation()',
      )
      expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toContain('public/_documentation')
      expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toContain('public/_documentation-root')
      const worker = readFileSync(join(dir, 'worker.ts'), 'utf-8')
      expect(worker).not.toContain('DocumentationAssistantLimiter')
      expect(worker).toContain("import documentationConfig from './documentation.json'")
      expect(worker).toContain(
        'registerDeepSpaceDocumentation(app, { resolveAuth, config: documentationConfig })',
      )
      const wrangler = readFileSync(join(dir, 'wrangler.toml'), 'utf-8')
      expect(wrangler).not.toContain('documentation-v1')
      expect(wrangler).toContain('name = "DOCUMENTATION_CLIENT_RATE_LIMITER"')
      expect(wrangler).toContain('namespace_id = "2001"')
      expect(wrangler).toContain('simple = { limit = 12, period = 60 }')
      expect(wrangler).toContain('name = "DOCUMENTATION_APP_RATE_LIMITER"')
      expect(wrangler).toContain('namespace_id = "2002"')
      expect(wrangler).toContain('simple = { limit = 120, period = 60 }')
      expect(wrangler).not.toContain('type = "ratelimit"')
      expect(wrangler).toContain('run_worker_first = true')
      expect(wrangler).not.toContain('run_worker_first = [')
      expect(parseToml(wrangler).ratelimits).toEqual([
        {
          name: 'DOCUMENTATION_CLIENT_RATE_LIMITER',
          namespace_id: '2001',
          simple: { limit: 12, period: 60 },
        },
        {
          name: 'DOCUMENTATION_APP_RATE_LIMITER',
          namespace_id: '2002',
          simple: { limit: 120, period: 60 },
        },
      ])

      expect(installInto(dir, ['documentation']).status).toBe(0)
      expect(readFileSync(join(dir, 'wrangler.toml'), 'utf-8')).toBe(wrangler)
    } finally {
      cleanup()
    }
  })

  it('replaces path lists with one worker-owned routing contract', () => {
    const { dir, cleanup } = makeApp()
    try {
      const wranglerPath = join(dir, 'wrangler.toml')
      const initial = readFileSync(wranglerPath, 'utf-8').replace(
        'run_worker_first = [',
        'run_worker_first = [\n  "/docs",\n  "/docs/*",',
      )
      writeFileSync(wranglerPath, initial)

      expect(installInto(dir, ['documentation']).status).toBe(0)
      const wrangler = readFileSync(wranglerPath, 'utf-8')
      expect(wrangler).toContain('run_worker_first = true')
      expect(wrangler).not.toContain('run_worker_first = [')
    } finally {
      cleanup()
    }
  })

  it('installs the same worker routing and rate limits into named environments', () => {
    const { dir, cleanup } = makeApp()
    try {
      const wranglerPath = join(dir, 'wrangler.toml')
      writeFileSync(
        wranglerPath,
        `${readFileSync(wranglerPath, 'utf-8').trimEnd()}\n\n[env.staging.assets]\ndirectory = "./dist"\nrun_worker_first = ["/api/*"]\n`,
      )

      expect(installInto(dir, ['documentation']).status).toBe(0)
      const wrangler = readFileSync(wranglerPath, 'utf-8')
      expect(wrangler).toMatch(/\[env\.staging\.assets\][\s\S]*?run_worker_first = true/u)
      expect(wrangler.match(/name = "DOCUMENTATION_CLIENT_RATE_LIMITER"/gu)).toHaveLength(2)
      expect(wrangler.match(/name = "DOCUMENTATION_APP_RATE_LIMITER"/gu)).toHaveLength(2)
      expect(wrangler).toContain('[[env.staging.ratelimits]]')

      expect(installInto(dir, ['documentation']).status).toBe(0)
      expect(readFileSync(wranglerPath, 'utf-8')).toBe(wrangler)
    } finally {
      cleanup()
    }
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

      const previewPath = join(dir, 'src', 'components', 'AttachmentPreview.tsx')
      const pagePath = join(dir, 'src', 'pages', '(app)', '(protected)', 'attachments.tsx')
      expect(existsSync(previewPath)).toBe(true)
      expect(readFileSync(previewPath, 'utf-8')).toContain("from '../hooks/useFilePreview'")
      expect(readFileSync(pagePath, 'utf-8')).toContain(
        "from '../../../components/AttachmentPreview'",
      )
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
  it('reruns the package manager after a failed install instead of treating declarations as done', async () => {
    const { dir, cleanup } = makeApp()
    const previousPath = process.env.PATH
    try {
      linkInstalledPackage(dir)
      process.env.PATH = ''
      const args = {
        feature: 'file-attachments',
        dir,
        install: true,
        list: false,
      }
      const first = await invokeAddJson(args)
      const retry = await invokeAddJson(args)

      for (const { exitCode, result } of [first, retry]) {
        expect(exitCode).toBe(1)
        expect(result).toMatchObject({
          ok: false,
          code: 'dependency_install_failed',
          error: expect.stringMatching(/Could not launch \w+/),
          installed: false,
        })
        expect(result).not.toHaveProperty('action')
      }
      expect(
        (retry.result.observedChanges as { dependencies: { added: unknown[] } }).dependencies.added
          .length,
      ).toBe(0)
    } finally {
      process.env.PATH = previousPath
      cleanup()
    }
  })

  it('returns only a bounded diagnostic tail when the package manager exits nonzero', async () => {
    if (process.platform === 'win32') return
    const { dir, cleanup } = makeApp()
    const previousPath = process.env.PATH
    try {
      linkInstalledPackage(dir)
      const binDir = join(dirname(dir), 'bin')
      mkdirSync(binDir)
      const fakeNpm = join(binDir, 'npm')
      writeFileSync(
        fakeNpm,
        [
          '#!/bin/sh',
          'i=0',
          'while [ "$i" -lt 2500 ]; do',
          '  printf \'noise-%04d-abcdefghij\\n\' "$i"',
          '  i=$((i + 1))',
          'done',
          "echo 'resolver-tail-sentinel' >&2",
          'exit 42',
          '',
        ].join('\n'),
      )
      chmodSync(fakeNpm, 0o755)
      process.env.PATH = binDir

      const { exitCode, result } = await invokeAddJson({
        feature: 'landing',
        dir,
        install: true,
        list: false,
      })
      expect(exitCode).toBe(1)
      expect(result).toMatchObject({
        ok: false,
        code: 'dependency_install_failed',
        installed: false,
        error: expect.stringContaining('resolver-tail-sentinel'),
      })
      const diagnosticTail = (
        result.observedChanges as { dependencies: { diagnosticTail: string } }
      ).dependencies.diagnosticTail
      expect(diagnosticTail).toContain('resolver-tail-sentinel')
      expect(diagnosticTail).not.toContain('noise-0000')
      expect(Buffer.byteLength(diagnosticTail)).toBeLessThanOrEqual(16 * 1024 + 64)
      expect(result).not.toHaveProperty('action')
    } finally {
      process.env.PATH = previousPath
      cleanup()
    }
  })
})

describe('post-install command guidance', () => {
  it('keeps terminal success factual instead of prescribing an optional dev server', () => {
    const { dir, cleanup } = makeApp()
    try {
      const { status, out } = installInto(dir, ['search-bar'])
      expect(status).toBe(0)
      expect(out).not.toContain('Start the dev server')
      expect(out).not.toContain('Next:')
      expect(existsSync(join(dir, 'src/components/search/SearchOverlay.tsx'))).toBe(true)
      expect(existsSync(join(dir, 'src/components/search/search-model.ts'))).toBe(true)
      expect(readFileSync(join(dir, 'src/components/search/SearchOverlay.tsx'), 'utf-8')).toContain(
        "from './search-model'",
      )
    } finally {
      cleanup()
    }
  })
})

describe('agent-facing install result', () => {
  it('reports customized-app wiring that could not be completed automatically', async () => {
    const { dir, cleanup } = makeApp()
    try {
      linkInstalledPackage(dir)
      writeFileSync(join(dir, 'src', 'schemas.ts'), 'export const schemas = []\n')
      writeFileSync(join(dir, 'src', 'nav.ts'), 'export const nav = []\n')

      const { exitCode, result } = await invokeAddJson({
        feature: 'items',
        dir,
        install: false,
        list: false,
      })
      expect(exitCode).toBe(1)
      expect(result).toMatchObject({
        ok: false,
        code: 'manual_integration_required',
        feature: 'items',
        installed: false,
        unresolvedIntegrations: expect.arrayContaining([
          expect.objectContaining({
            area: 'schema',
            steps: expect.arrayContaining([expect.stringContaining('itemsSchema')]),
          }),
          expect.objectContaining({
            area: 'nav',
            steps: expect.arrayContaining([expect.stringContaining("path: '/items'")]),
          }),
        ]),
      })
      expect(result).not.toHaveProperty('action')
      expect(existsSync(join(dir, 'src/pages/(app)/(protected)/items.tsx'))).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('reports observed file changes separately from declared manifest guidance', async () => {
    const { dir, cleanup } = makeApp()
    try {
      const result = await runAddJson(dir, 'search-bar')

      expect(result).toMatchObject({
        ok: true,
        feature: 'search-bar',
        dir,
        installed: true,
        observedChanges: {
          files: {
            created: [
              'src/components/search/search-model.ts',
              'src/components/search/SearchOverlay.tsx',
            ],
            preexisting: [],
            missing: [],
          },
          dependencies: {
            added: [],
            missingDeclarations: [],
            installRequested: false,
          },
        },
        manifestGuidance: {
          instructions: expect.arrayContaining([
            expect.stringContaining('Import InlineSearch, SearchOverlay, or SearchResultList'),
          ]),
          patterns: expect.arrayContaining([
            expect.stringContaining('For local feed/list filtering'),
          ]),
          agentNotes: expect.arrayContaining([
            expect.stringContaining('Use InlineSearch when search belongs'),
          ]),
        },
      })
      // Manual wiring is the immediate guidance; starting dev is not presented
      // as though that declared work had already happened.
      expect(result).not.toHaveProperty('action')
    } finally {
      cleanup()
    }
  })

  it('reports actual dependency additions and makes install the immediate action', async () => {
    const { dir, cleanup } = makeApp()
    try {
      const retainedPath = join(dir, 'src', 'hooks', 'useMimeTypeDetection.ts')
      mkdirSync(dirname(retainedPath), { recursive: true })
      writeFileSync(retainedPath, '// user-owned file\n')

      const result = await runAddJson(dir, 'file-attachments')
      const observed = result.observedChanges as {
        files: { created: string[]; preexisting: string[] }
        dependencies: {
          added: Array<{ name: string; section: string; version: unknown }>
        }
      }

      expect(observed.files.created).toContain('src/pages/(app)/(protected)/attachments.tsx')
      expect(observed.files.created).not.toContain('src/hooks/useMimeTypeDetection.ts')
      expect(observed.files.preexisting).toContain('src/hooks/useMimeTypeDetection.ts')
      expect(observed.dependencies.added).toEqual(
        expect.arrayContaining([
          { name: 'papaparse', section: 'dependencies', version: '^5.4.1' },
          {
            name: '@types/papaparse',
            section: 'devDependencies',
            version: '^5.3.0',
          },
        ]),
      )
      expect(observed.dependencies.added).toHaveLength(9)
      expect(result.action).toEqual({ cwd: dir, argv: ['npm', 'install'] })
      expect(JSON.stringify(result)).not.toContain('deepspace dev start')
    } finally {
      cleanup()
    }
  })

  it("uses the app's explicit package manager in the dependency action", async () => {
    const { dir, cleanup } = makeApp()
    try {
      const packagePath = join(dir, 'package.json')
      const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'))
      pkg.packageManager = 'pnpm@10.15.0'
      writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)

      const result = await runAddJson(dir, 'file-attachments')
      expect(result.action).toEqual({ cwd: dir, argv: ['pnpm', 'install'] })
    } finally {
      cleanup()
    }
  })

  it('keeps terminal success factual instead of inventing a dev-server action', async () => {
    const { dir, cleanup } = makeApp()
    try {
      const result = await runAddJson(dir, 'items')
      expect(result).toMatchObject({
        ok: true,
        installed: true,
        manifestGuidance: { instructions: [] },
      })
      expect(result).not.toHaveProperty('action')
    } finally {
      cleanup()
    }
  })
})

describe('ai-chat feature assembly', () => {
  it('installs the complete ChatPanel subsystem', () => {
    const { dir, cleanup } = makeApp()
    try {
      const { status } = installInto(dir, ['ai-chat'])
      expect(status).toBe(0)
      for (const file of ['ChatPanel.tsx', 'ChatPanel.messages.tsx', 'ChatPanel.stream.ts']) {
        expect(existsSync(join(dir, 'src', 'components', file)), file).toBe(true)
      }
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
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { deepspace: '^0.5.0' } }),
    )
    expect(isDeepSpaceApp(dir)).toBe(true)
  })

  it('is true when deepspace is only a devDependency', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { deepspace: '^0.5.0' } }),
    )
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

describe('feature installer resolution', () => {
  it("runs the typed installer from the target app's installed package", async () => {
    const { dir, cleanup } = makeApp()
    const installedRoot = join(dir, 'node_modules', 'deepspace')
    mkdirSync(join(installedRoot, 'dist'), { recursive: true })
    mkdirSync(join(installedRoot, 'features'), { recursive: true })
    writeFileSync(
      join(installedRoot, 'package.json'),
      JSON.stringify({ name: 'deepspace', version: 'target-fixture', type: 'module' }),
    )
    writeFileSync(
      join(installedRoot, 'dist', 'feature-installer.js'),
      [
        "import { writeFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        'export function installFeature(options) {',
        "  writeFileSync(join(options.targetDir, 'target-installer-ran'), 'yes')",
        '  return {',
        '    ok: true,',
        '    data: { feature: options.feature, dir: options.targetDir, installed: true, installerVersion: "target-fixture" },',
        '  }',
        '}',
      ].join('\n'),
    )

    try {
      const result = await runAddJson(dir, 'target-only-feature', false, false)
      expect(result).toMatchObject({
        ok: true,
        feature: 'target-only-feature',
        installerVersion: 'target-fixture',
      })
      expect(readFileSync(join(dir, 'target-installer-ran'), 'utf-8')).toBe('yes')
    } finally {
      cleanup()
    }
  })

  it("keeps a target installer's unknown-feature facts without a running-catalog loop", async () => {
    const { dir, cleanup } = makeApp()
    const installedRoot = join(dir, 'node_modules', 'deepspace')
    mkdirSync(join(installedRoot, 'dist'), { recursive: true })
    mkdirSync(join(installedRoot, 'features'), { recursive: true })
    writeFileSync(
      join(installedRoot, 'package.json'),
      JSON.stringify({ name: 'deepspace', version: 'target-fixture', type: 'module' }),
    )
    writeFileSync(
      join(installedRoot, 'dist', 'feature-installer.js'),
      [
        'export function installFeature(options) {',
        '  return {',
        '    ok: false,',
        '    code: "unknown_feature",',
        '    error: `Unknown target feature: ${options.feature}`,',
        '    data: {',
        '      requestedFeature: options.feature,',
        '      suggestedFeature: "target-neighbor",',
        '      availableFeatures: [{ id: "target-only", name: "Target only", category: "data", description: null }],',
        '    },',
        '  }',
        '}',
      ].join('\n'),
    )

    try {
      const { exitCode, result } = await invokeAddJson({
        feature: 'items',
        dir,
        install: false,
        list: false,
      })
      expect(exitCode).toBe(1)
      expect(result).toMatchObject({
        ok: false,
        code: 'unknown_feature',
        requestedFeature: 'items',
        suggestedFeature: 'target-neighbor',
        availableFeatures: [expect.objectContaining({ id: 'target-only' })],
      })
      expect(result).not.toHaveProperty('action')
      expect(JSON.stringify(result)).not.toContain('add --list')
    } finally {
      cleanup()
    }
  })

  it('refuses an app-local legacy script when the installed package has no typed entry', async () => {
    const { dir, cleanup } = makeApp()
    mkdirSync(join(dir, 'node_modules', 'deepspace'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'deepspace', 'package.json'), '{}\n')
    mkdirSync(join(dir, '.deepspace', 'scripts'), { recursive: true })
    writeFileSync(
      join(dir, '.deepspace', 'scripts', 'add-feature.cjs'),
      "require('node:fs').writeFileSync('legacy-script-ran', 'yes')\n",
    )

    try {
      const { exitCode, result } = await invokeAddJson({
        feature: 'messaging',
        dir,
        install: false,
        list: false,
      })
      expect(exitCode).toBe(1)
      expect(result).toMatchObject({ ok: false, code: 'feature_installer_missing' })
      expect(result.error).toContain('node_modules/deepspace/dist/feature-installer.js')
      expect(result.error).not.toContain('.deepspace/scripts/add-feature.cjs')
      expect(existsSync(join(dir, 'legacy-script-ran'))).toBe(false)
    } finally {
      cleanup()
    }
  })
})
