import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deepSpaceDocumentation } from '../vite'

describe('DeepSpace documentation Vite bridge', () => {
  it('compiles production assets into Vite public output', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-documentation-build-'))
    writeFileSync(
      join(appDir, 'documentation.json'),
      JSON.stringify({
        name: 'Build fixture',
        navigation: [{ group: 'Guides', pages: ['index'] }],
      }),
    )
    mkdirSync(join(appDir, 'documentation'))
    writeFileSync(join(appDir, 'documentation', 'index.mdx'), '# Built documentation')
    const plugin = deepSpaceDocumentation()
    expect(plugin).not.toHaveProperty('apply')
    plugin.config({ root: appDir }, { command: 'build' })

    const manifestPath = join(appDir, 'public', '_documentation', 'manifest.json')
    expect(existsSync(manifestPath)).toBe(true)
    expect(JSON.parse(readFileSync(manifestPath, 'utf-8'))).toMatchObject({ pageCount: 1 })
  })

  it('uses the same ASSETS source in development and removes obsolete private caches', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-documentation-serve-'))
    writeFileSync(
      join(appDir, 'documentation.json'),
      JSON.stringify({ name: 'Dev fixture', navigation: [{ group: 'Guides', pages: ['index'] }] }),
    )
    mkdirSync(join(appDir, 'documentation'))
    writeFileSync(join(appDir, 'documentation', 'index.mdx'), '# Development documentation')
    mkdirSync(join(appDir, '.deepspace', 'documentation'), { recursive: true })
    writeFileSync(join(appDir, '.deepspace', 'documentation', 'stale.txt'), 'stale')

    const config = deepSpaceDocumentation().config({ root: appDir }, { command: 'serve' })

    expect(existsSync(join(appDir, 'public', '_documentation', 'manifest.json'))).toBe(true)
    expect(existsSync(join(appDir, '.deepspace', 'documentation'))).toBe(false)
    expect(config).toMatchObject({
      server: {
        watch: {
          ignored: ['**/.deepspace/documentation*/**', '**/public/_documentation*/**'],
        },
      },
    })
  })

  it('stamps release URLs when deploy provides the public base URL', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-documentation-baseurl-'))
    writeFileSync(
      join(appDir, 'documentation.json'),
      JSON.stringify({ name: 'Base fixture', navigation: [{ group: 'Guides', pages: ['index'] }] }),
    )
    mkdirSync(join(appDir, 'documentation'))
    writeFileSync(join(appDir, 'documentation', 'index.mdx'), '# Released documentation')

    process.env.DEEPSPACE_DOCUMENTATION_BASE_URL = 'https://fixture.app.space/docs'
    try {
      deepSpaceDocumentation().config({ root: appDir }, { command: 'build' })
    } finally {
      delete process.env.DEEPSPACE_DOCUMENTATION_BASE_URL
    }

    expect(readFileSync(join(appDir, 'public', '_documentation', 'sitemap.xml'), 'utf8')).toContain(
      'https://fixture.app.space/docs',
    )
  })

  it('compiles the same root variant in development and production', () => {
    for (const command of ['serve', 'build'] as const) {
      const appDir = mkdtempSync(join(tmpdir(), `deepspace-documentation-${command}-`))
      writeFileSync(
        join(appDir, 'documentation.json'),
        JSON.stringify({
          name: 'Domain fixture',
          domains: ['docs.example.com'],
          navigation: [{ group: 'Guides', pages: ['index'] }],
        }),
      )
      mkdirSync(join(appDir, 'documentation'))
      writeFileSync(join(appDir, 'documentation', 'index.mdx'), '# Domain documentation')

      deepSpaceDocumentation().config({ root: appDir }, { command })
      const rootOutput = join(appDir, 'public', '_documentation-root')
      expect(existsSync(join(rootOutput, 'manifest.json'))).toBe(true)
      expect(readFileSync(join(rootOutput, 'index.html'), 'utf8')).toContain('href="/assets/')
    }
  })

  it('stops suppressing source add events after the initial watcher replay', async () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-documentation-watcher-'))
    writeFileSync(
      join(appDir, 'documentation.json'),
      JSON.stringify({
        name: 'Watcher fixture',
        navigation: [{ group: 'Guides', pages: ['index'] }],
      }),
    )
    mkdirSync(join(appDir, 'documentation'))
    const sourcePath = join(appDir, 'documentation', 'index.mdx')
    writeFileSync(sourcePath, '# Original source')

    const plugin = deepSpaceDocumentation()
    plugin.config({ root: appDir }, { command: 'serve' })
    let onAll: ((event: string, path: string) => void) | undefined
    let onReady: (() => void) | undefined
    plugin.configureServer({
      async restart() {},
      watcher: {
        add() {},
        on: ((event: string, handler: (...args: string[]) => void) => {
          if (event === 'all') onAll = handler
          if (event === 'ready') onReady = handler
        }) as Parameters<typeof plugin.configureServer>[0]['watcher']['on'],
      },
      config: {
        logger: {
          info() {},
          error(message) {
            throw new Error(message)
          },
        },
      },
    })
    onReady!()
    writeFileSync(sourcePath, '# Recreated source')
    onAll!('add', sourcePath)
    await new Promise((resolve) => setTimeout(resolve, 180))

    expect(readFileSync(join(appDir, 'public', '_documentation', 'index.md'), 'utf8')).toContain(
      'Recreated source',
    )
  })

  it('restarts the Worker only when documentation domains change', async () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-documentation-domains-'))
    const configPath = join(appDir, 'documentation.json')
    const config = (domains: string[], name = 'Domain fixture') =>
      JSON.stringify({ name, domains, navigation: ['index'] })
    writeFileSync(configPath, config([]))
    mkdirSync(join(appDir, 'documentation'))
    writeFileSync(join(appDir, 'documentation', 'index.mdx'), '# Domain fixture')

    const plugin = deepSpaceDocumentation()
    plugin.config({ root: appDir }, { command: 'serve' })
    let onAll: ((event: string, path: string) => void) | undefined
    let restarts = 0
    plugin.configureServer({
      async restart() {
        restarts++
      },
      watcher: {
        add() {},
        on: ((event: string, handler: (...args: string[]) => void) => {
          if (event === 'all') onAll = handler
        }) as Parameters<typeof plugin.configureServer>[0]['watcher']['on'],
      },
      config: { logger: { info() {}, error() {} } },
    })

    writeFileSync(configPath, config(['docs.example.com']))
    onAll!('change', configPath)
    await new Promise((resolve) => setTimeout(resolve, 180))
    expect(restarts).toBe(1)

    writeFileSync(configPath, config(['docs.example.com'], 'Renamed fixture'))
    onAll!('change', configPath)
    await new Promise((resolve) => setTimeout(resolve, 180))
    expect(restarts).toBe(1)
  })
})
