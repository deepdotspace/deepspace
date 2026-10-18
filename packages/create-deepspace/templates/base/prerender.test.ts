import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { build, type ResolvedConfig } from 'vite'
import { prerender } from './prerender'

vi.mock('vite', async (original) => ({
  ...await original<typeof import('vite')>(),
  build: vi.fn(),
}))

const dirs: string[] = []
afterEach(() => {
  vi.clearAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function buildPages(noindex: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'scaffold-seo-'))
  dirs.push(root)
  const client = join(root, 'dist/client')
  mkdirSync(client, { recursive: true })
  writeFileSync(join(client, 'index.html'), '<html><head><title>Fallback</title></head><body><div id="root"></div></body></html>')
  // Simulate a prior sitemap, or one copied from public/.
  writeFileSync(join(client, 'sitemap.xml'), '<urlset><loc>https://old.test/</loc></urlset>')
  vi.mocked(build).mockImplementation(async () => {
    const ssrDir = join(root, 'dist/prerender')
    mkdirSync(ssrDir, { recursive: true })
    writeFileSync(join(ssrDir, 'entry.mjs'), `
      export const seo = { origin: 'https://example.test', noindex: ${noindex} };
      export const PRERENDER_ROUTES = ['/', '/excluded'];
      export function render(route) {
        return '<title>Public page</title><meta name="description" content="A real page"/>' +
          (route === '/excluded' ? '<meta content="noindex, nofollow" name="robots"/>' : '') +
          '<div data-testid="app-root"><h1>Page content</h1></div>';
      }
    `)
    return []
  })

  const plugin = prerender()
  // Exercise the real client-output hook, with only the separate SSR compiler
  // replaced by a deterministic entry. Assertions cover shipped HTML/files.
  const configResolved = plugin.configResolved as (config: ResolvedConfig) => void
  configResolved({ command: 'build', root, define: {} } as ResolvedConfig)
  const closeBundle = plugin.closeBundle as (this: unknown) => Promise<void>
  await closeBundle.call({ environment: { config: { build: { outDir: client } } } })
  return client
}

describe('prerender indexing policy', () => {
  it('keeps excluded pages accessible but omits them from the sitemap', async () => {
    const client = await buildPages(false)
    const sitemap = readFileSync(join(client, 'sitemap.xml'), 'utf8')
    expect(sitemap).toContain('<loc>https://example.test/</loc>')
    expect(sitemap).not.toContain('/excluded')
    expect(readFileSync(join(client, 'excluded.html'), 'utf8')).toContain('noindex, nofollow')
    expect(readFileSync(join(client, 'index.html'), 'utf8')).not.toContain('noindex')
    expect(readFileSync(join(client, 'robots.txt'), 'utf8')).toContain('Sitemap: https://example.test/sitemap.xml')
    expect(readFileSync(join(client, '_spa.html'), 'utf8')).not.toContain('Page content')
  })

  it('enforces site noindex even when a page omits it and lets crawlers read it', async () => {
    const client = await buildPages(true)
    for (const file of ['index.html', 'excluded.html', '_spa.html']) {
      const html = readFileSync(join(client, file), 'utf8')
      expect(html).toContain('noindex, nofollow')
      expect(html.match(/name="robots"/g)).toHaveLength(1)
    }
    expect(readFileSync(join(client, 'robots.txt'), 'utf8')).toBe('User-agent: *\nAllow: /\n')
    expect(existsSync(join(client, 'sitemap.xml'))).toBe(false)
  })
})
