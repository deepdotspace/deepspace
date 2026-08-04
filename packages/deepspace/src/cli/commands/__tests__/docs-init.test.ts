import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installDocsWorkerSupport } from '../docs'

describe('docs init worker migration', () => {
  it('wires SDK-owned docs routes and a durable limiter into a legacy app idempotently', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-docs-init-'))
    writeFileSync(
      join(appDir, 'worker.ts'),
      [
        "import { Hono } from 'hono'",
        "import { RecordRoom, registerDocsAssistantRoutes, registerDocsMcpRoutes, registerDocsStaticRoutes } from 'deepspace/worker'",
        "import type { DOBindings, DOManifest } from 'deepspace/worker'",
        'export const __DO_MANIFEST__ = [',
        "  { binding: 'RECORD_ROOMS', className: 'AppRecordRoom', sqlite: true },",
        "  { binding: 'DOCS_ASSISTANT_LIMITER', className: 'AppDocsAssistantLimiter', sqlite: true },",
        '] as const satisfies DOManifest',
        'export class AppRecordRoom extends RecordRoom<Env> {}',
        'export interface Env extends DOBindings<typeof __DO_MANIFEST__> { ASSETS: Fetcher }',
        'type AppContext = { Bindings: Env }',
        'const app = new Hono<AppContext>()',
        'const resolveAuth = async () => null',
        'registerDocsAssistantRoutes(app, resolveAuth)',
        'registerDocsMcpRoutes(app)',
        'registerDocsStaticRoutes(app)',
        'registerPlatformProxyRoutes(app)',
        'registerStaticRoutes(app)',
        'export default app',
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(appDir, 'wrangler.toml'),
      [
        'name = "legacy"',
        '[assets]',
        'directory = "dist"',
        'run_worker_first = ["/api/*"]',
        '[[migrations]]',
        'tag = "v1"',
        'new_sqlite_classes = ["AppRecordRoom"]',
        '[durable_objects]',
        'bindings = [',
        '  { name = "RECORD_ROOMS", class_name = "AppRecordRoom" },',
        ']',
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(appDir, 'vite.config.ts'),
      [
        "import { defineConfig } from 'vite'",
        'export default defineConfig({',
        '  plugins: [],',
        '})',
        '',
      ].join('\n'),
    )
    writeFileSync(join(appDir, '.gitignore'), 'node_modules\ndist\n')

    expect(installDocsWorkerSupport(appDir).map((path) => path.slice(appDir.length + 1))).toEqual([
      'worker.ts',
      'wrangler.toml',
      'vite.config.ts',
      '.gitignore',
    ])
    expect(installDocsWorkerSupport(appDir)).toEqual([])

    const worker = readFileSync(join(appDir, 'worker.ts'), 'utf8')
    expect(worker).toContain('registerDeepSpaceDocs(app, { resolveAuth })')
    expect(worker).toContain("docsAssistantLimiterManifestEntry('AppDocsAssistantLimiter')")
    expect(worker.match(/docsAssistantLimiterManifestEntry\('AppDocsAssistantLimiter'\)/g)).toHaveLength(1)
    expect(worker).not.toContain("binding: 'DOCS_ASSISTANT_LIMITER'")
    expect(worker).not.toContain('registerDocsAssistantRoutes')
    expect(worker).not.toContain('registerDocsMcpRoutes')
    expect(worker).not.toContain('registerDocsStaticRoutes')
    expect(worker).toContain('class AppDocsAssistantLimiter extends DocsAssistantLimiter')
    expect(worker.indexOf('registerDeepSpaceDocs(app, { resolveAuth })')).toBeLessThan(
      worker.indexOf('registerPlatformProxyRoutes(app)'),
    )

    const wrangler = readFileSync(join(appDir, 'wrangler.toml'), 'utf8')
    expect(wrangler).toContain('name = "DOCS_ASSISTANT_LIMITER"')
    expect(wrangler).toContain('tag = "docs-v1"')
    expect(wrangler).toContain('new_sqlite_classes = ["AppDocsAssistantLimiter"]')
    expect(wrangler).toContain('run_worker_first = ["/api/*"]')

    const vite = readFileSync(join(appDir, 'vite.config.ts'), 'utf8')
    expect(vite).toContain("import { deepSpaceDocs } from 'deepspace/docs'")
    expect(vite).toContain('plugins: [\n    deepSpaceDocs(),')
    expect(readFileSync(join(appDir, '.gitignore'), 'utf8')).toContain('public/_docs\n')
  })
})
