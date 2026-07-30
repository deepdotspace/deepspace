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
 *    the ai-chat feature's ChatPanel and schema wrapper (copy-paste-ownable
 *    is the template model — no runtime install). The copies must stay
 *    byte-identical to their feature sources so fixes land in one place and
 *    propagate by re-copying; this already failed once (a model-lineup
 *    refresh updated the feature but not the template).
 */
import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import {
  TEMPLATES_DIR,
  FEATURES_DIR,
  listOverlays,
  assembleTemplate,
} from './template-assembly'

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
        for (const required of ['index.html', 'package.json', 'worker.ts', 'src/main.tsx']) {
          expect(existsSync(join(app, required)), `${overlay} is missing ${required}`).toBe(true)
        }
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
        expect(dangling, `unresolved imports in assembled ${overlay}:\n${dangling.join('\n')}`).toEqual([])
      })
    })
  }
})

describe('copilot fork stays in sync with the ai-chat feature', () => {
  const pairs: Array<[template: string, feature: string]> = [
    [
      join(TEMPLATES_DIR, 'copilot', 'src', 'components', 'chat', 'ChatPanel.tsx'),
      join(FEATURES_DIR, 'ai-chat', 'src', 'ChatPanel.tsx'),
    ],
    [
      join(TEMPLATES_DIR, 'copilot', 'src', 'schemas', 'ai-chat-schema.ts'),
      join(FEATURES_DIR, 'ai-chat', 'src', 'ai-chat-schema.ts'),
    ],
  ]

  for (const [templateCopy, featureSource] of pairs) {
    it(`${templateCopy.split('/').slice(-1)[0]} matches its feature source`, () => {
      expect(readFileSync(templateCopy, 'utf-8'),
        `template copy has drifted from the feature source — apply the change to ` +
        `${featureSource} and re-copy it over ${templateCopy} (or vice versa)`,
      ).toBe(readFileSync(featureSource, 'utf-8'))
    })
  }
})
