/**
 * Assembled-template health checks.
 *
 * The scaffolder ships base + overlay; an overlay is not independently
 * compilable, so a file deleted or renamed in base can break ONLY the
 * assembled app — which no other test builds for every overlay. Two guards:
 *
 * 1. Import resolution: every relative / `@/` import in every assembled
 *    template must point at a file that exists in the assembled tree.
 *    Catches "renamed a base ui export file", "overlay imports a deleted
 *    module", and route-group moves that broke `../` depths.
 *
 * 2. Fork drift: the copilot template intentionally ships owned COPIES of
 *    the ai-chat feature's ChatPanel subsystem and schema wrapper
 *    (copy-paste-ownable is the template model — no runtime install). The
 *    copies must stay byte-identical to their feature sources so fixes land in one place and
 *    propagate by re-copying; this already failed once (a model-lineup
 *    refresh updated the feature but not the template).
 */
import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { TEMPLATES_DIR, FEATURES_DIR, listOverlays, assembleTemplate } from './template-assembly'

const cleanups: string[] = []
afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
})

function makeAssembled(overlay: string): string {
  const root = mkdtempSync(join(tmpdir(), `ds-template-${overlay}-`))
  cleanups.push(root)
  const dir = join(root, 'app')
  assembleTemplate(overlay, dir)
  return dir
}

/** All .ts/.tsx files under dir, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry === 'node_modules') continue
      out.push(...sourceFiles(p))
    } else if (/\.tsx?$/.test(entry)) {
      out.push(p)
    }
  }
  return out
}

/** Static import/export specifiers in a source file (no dynamic imports). */
function importSpecifiers(source: string): string[] {
  // Strip comments first — doc comments quote import examples (e.g. the ui
  // barrel's "import { Button } from '../components/ui'"). Regex-grade
  // stripping is fine here: template sources don't put `/*` in strings.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const specs: string[] = []
  // `import ... from 'x'`, `export ... from 'x'`, and bare `import 'x'`.
  const re = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g
  for (let m = re.exec(code); m; m = re.exec(code)) {
    specs.push(m[1] ?? m[2])
  }
  return specs
}

/** Resolve a relative/aliased specifier the way vite/tsc (NodeNext) would. */
function resolves(fromFile: string, appDir: string, spec: string): boolean {
  const base = spec.startsWith('@/')
    ? join(appDir, 'src', spec.slice(2))
    : resolve(dirname(fromFile), spec)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    // NodeNext style: `./tools.js` refers to `./tools.ts` in source.
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
  ]
  return candidates.some((c) => existsSync(c) && statSync(c).isFile())
}

describe('assembled templates', () => {
  for (const overlay of listOverlays()) {
    describe(`${overlay} (base + overlay)`, () => {
      it('ships the entrypoints every app needs', () => {
        const app = makeAssembled(overlay)
        for (const required of [
          'index.html',
          'package.json',
          'worker.ts',
          'src/main.tsx',
          'src/server/action-routes.ts',
          'src/server/http-routes.ts',
          'src/server/realtime-routes.ts',
        ]) {
          expect(existsSync(join(app, required)), `${overlay} is missing ${required}`).toBe(true)
        }
      })

      it('assembles worker routes in security-sensitive order', () => {
        const app = makeAssembled(overlay)
        const worker = readFileSync(join(app, 'worker.ts'), 'utf-8')
        const registrations = [
          'registerAuthAndIntegrationRoutes(app)',
          'registerRealtimeRoutes(app)',
          'registerActionRoutes(app, resolveAuth)',
          'registerAiChatRoutes(app, resolveAuth)',
          'registerPlatformProxyRoutes(app)',
          'registerStaticRoutes(app)',
        ]
        const positions = registrations.map((registration) => worker.indexOf(registration))
        expect(positions.every((position) => position >= 0)).toBe(true)
        expect(positions).toEqual([...positions].sort((left, right) => left - right))

        const httpRoutes = readFileSync(join(app, 'src/server/http-routes.ts'), 'utf-8')
        expect(httpRoutes.indexOf("app.all('/api/auth/sign-out'")).toBeLessThan(
          httpRoutes.indexOf("app.all('/api/auth/*'"),
        )
        expect(httpRoutes).toContain("headers.delete('x-user-id')")
        expect(httpRoutes).toContain("headers.delete('x-app-identity-token')")
      })

      it('has no dangling relative or @/ imports', () => {
        const app = makeAssembled(overlay)
        const dangling: string[] = []
        for (const file of sourceFiles(app)) {
          const source = readFileSync(file, 'utf-8')
          for (const spec of importSpecifiers(source)) {
            if (!spec.startsWith('.') && !spec.startsWith('@/')) continue // npm dep
            if (!resolves(file, app, spec)) {
              dangling.push(`${file.slice(app.length + 1)} → '${spec}'`)
            }
          }
        }
        expect(
          dangling,
          `unresolved imports in assembled ${overlay}:\n${dangling.join('\n')}`,
        ).toEqual([])
      })

      it('uses the current CLI command tree', () => {
        const app = makeAssembled(overlay)
        const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf-8')) as {
          scripts?: Record<string, string>
        }
        expect(pkg.scripts).toMatchObject({
          dev: 'deepspace dev start',
          test: 'deepspace test run',
          'test:smoke': 'deepspace test run smoke',
          'test:api': 'deepspace test run api',
          'test:e2e': 'deepspace test run e2e',
          screenshot: 'deepspace test screenshot',
        })

        const agentGuide = readFileSync(join(app, 'AGENTS.md'), 'utf-8')
        expect(agentGuide).toContain('npx deepspace auth login')
        expect(agentGuide).toContain('npx deepspace dev start')
        expect(agentGuide).toMatch(/default DeepSpace\s+source/)
        expect(agentGuide).toMatch(/explicit GitHub source claim/)
        expect(agentGuide).toContain('dirty or unpushed bytes')
        expect(readFileSync(join(app, 'CLAUDE.md'), 'utf-8').trim()).toBe(
          'See [AGENTS.md](./AGENTS.md).',
        )
      })
    })
  }
})

describe('installable feature UI quality', () => {
  it('keeps the file manager safe and aligned with the scaffold UI contract', () => {
    const source = readFileSync(
      join(FEATURES_DIR, 'file-manager', 'src', 'FileManagerPage.tsx'),
      'utf-8',
    )
    const manifest = JSON.parse(
      readFileSync(join(FEATURES_DIR, 'file-manager', 'feature.json'), 'utf-8'),
    ) as { patterns: string[] }

    expect(source).not.toMatch(/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/)
    expect(source).not.toContain('animate-spin')
    expect(source).not.toMatch(/title="(?:Download|Delete|Preview)"/)
    expect(source).not.toContain('getUrl')
    for (const localPrimitive of ['Button', 'ConfirmModal', 'EmptyState', 'Modal', 'useToast']) {
      expect(source).toContain(localPrimitive)
    }
    for (const visibleOutcome of [
      'File uploaded',
      'Could not upload',
      'Could not download',
      'File deleted',
      'Could not delete',
      'Could not preview',
    ]) {
      expect(source).toContain(visibleOutcome)
    }
    expect(source).toContain("from 'lucide-react'")
    expect(source).toContain('await readFile(file)')
    expect(source).toContain('URL.createObjectURL')
    expect(manifest.patterns).toContain('Authenticated inline image preview with readFile()')
  })

  it('keeps the items reference feature aligned with the scaffold UI contract', () => {
    const source = readFileSync(join(FEATURES_DIR, 'items', 'src', 'ItemsPage.tsx'), 'utf-8')

    expect(source).not.toMatch(/<(?:button|input|label|textarea|svg)\b/)
    expect(source).not.toMatch(/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/)

    for (const localPrimitive of [
      'Button',
      'ConfirmModal',
      'EmptyState',
      'Input',
      'Label',
      'Textarea',
      'useToast',
    ]) {
      expect(source).toContain(localPrimitive)
    }
    expect(source).toContain("from 'lucide-react'")

    for (const visibleOutcome of [
      'Item created',
      'Could not create item',
      'Item archived',
      'Item restored',
      'Could not update item',
      'Item deleted',
      'Could not delete item',
    ]) {
      expect(source).toContain(visibleOutcome)
    }

    expect(source).toMatch(
      /const created = await onCreate\([\s\S]*if \(!created\) return[\s\S]*onClose\(\)/,
    )
    for (const confirmedMutation of ['createConfirmed', 'putConfirmed', 'removeConfirmed']) {
      expect(source).toContain(confirmedMutation)
    }
    expect(source).toContain('await putConfirmed(itemId, { status: newStatus })')
    expect(source).not.toContain('{ ...item.data, status: newStatus }')
  })

  it('keeps the leaderboard reference feature aligned with the scaffold UI contract', () => {
    const source = readFileSync(
      join(FEATURES_DIR, 'leaderboard', 'src', 'LeaderboardPage.tsx'),
      'utf-8',
    )

    expect(source).not.toMatch(/<(?:button|input|label|option|select|svg)\b/)
    expect(source).not.toMatch(/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/)

    for (const localPrimitive of [
      'Button',
      'ConfirmModal',
      'EmptyState',
      'Input',
      'Label',
      'Select',
      'useToast',
    ]) {
      expect(source).toContain(localPrimitive)
    }
    expect(source).toContain("from 'lucide-react'")

    for (const visibleOutcome of [
      'Score submitted',
      'Could not submit score',
      'Could not load leaderboard',
      'Score updated',
      'Could not update score',
      'Score deleted',
      'Could not delete score',
    ]) {
      expect(source).toContain(visibleOutcome)
    }

    expect(source).toMatch(
      /const submitted = await onSubmit\([\s\S]*if \(!submitted\) return[\s\S]*onClose\(\)/,
    )
    expect(source).toMatch(
      /const saved = await onSave\([\s\S]*if \(!saved\) return[\s\S]*onClose\(\)/,
    )
    for (const confirmedMutation of ['createConfirmed', 'putConfirmed', 'removeConfirmed']) {
      expect(source).toContain(confirmedMutation)
    }
    expect(source).toContain('await putConfirmed(entry.recordId, { score: newScore })')
    expect(source).not.toContain('{ ...entry.data, score: newScore }')
  })
})

describe('copilot fork stays in sync with the ai-chat feature', () => {
  const pairs: Array<[template: string, feature: string]> = [
    [
      join(TEMPLATES_DIR, 'copilot', 'src', 'components', 'chat', 'ChatPanel.tsx'),
      join(FEATURES_DIR, 'ai-chat', 'src', 'ChatPanel.tsx'),
    ],
    [
      join(TEMPLATES_DIR, 'copilot', 'src', 'components', 'chat', 'ChatPanel.messages.tsx'),
      join(FEATURES_DIR, 'ai-chat', 'src', 'ChatPanel.messages.tsx'),
    ],
    [
      join(TEMPLATES_DIR, 'copilot', 'src', 'components', 'chat', 'ChatPanel.stream.ts'),
      join(FEATURES_DIR, 'ai-chat', 'src', 'ChatPanel.stream.ts'),
    ],
    [
      join(TEMPLATES_DIR, 'copilot', 'src', 'schemas', 'ai-chat-schema.ts'),
      join(FEATURES_DIR, 'ai-chat', 'src', 'ai-chat-schema.ts'),
    ],
  ]

  for (const [templateCopy, featureSource] of pairs) {
    it(`${templateCopy.split('/').slice(-1)[0]} matches its feature source`, () => {
      expect(
        readFileSync(templateCopy, 'utf-8'),
        `template copy has drifted from the feature source — apply the change to ` +
          `${featureSource} and re-copy it over ${templateCopy} (or vice versa)`,
      ).toBe(readFileSync(featureSource, 'utf-8'))
    })
  }
})
