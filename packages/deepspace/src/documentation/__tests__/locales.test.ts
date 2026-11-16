import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDocumentation } from '../build'
import { validateDocumentation } from '../graph'
import { DocumentationError, type DocumentationRuntimeData } from '../types'

function fixture(config: Record<string, unknown>, pages: Record<string, string>): string {
  const appDir = mkdtempSync(join(tmpdir(), 'deepspace-documentation-locales-'))
  mkdirSync(join(appDir, 'documentation'), { recursive: true })
  writeFileSync(
    join(appDir, 'documentation.json'),
    `${JSON.stringify({ name: 'Test Documentation', ...config }, null, 2)}\n`,
  )
  for (const [path, content] of Object.entries(pages)) {
    const destination = join(appDir, 'documentation', path)
    mkdirSync(join(destination, '..'), { recursive: true })
    writeFileSync(destination, content)
  }
  return appDir
}

function sourceHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function translation(source: string, body: string, hash = sourceHash(source)): string {
  return `---\nsourceHash: "${hash}"\n---\n\n${body}`
}

function bootstrap(html: string): DocumentationRuntimeData {
  const match = html.match(/<script id="deepspace-documentation-data" type="application\/json">([^<]*)<\/script>/)
  return JSON.parse(match![1]!) as DocumentationRuntimeData
}

function validationError(appDir: string): DocumentationError {
  try {
    validateDocumentation(appDir)
  } catch (error) {
    if (error instanceof DocumentationError) return error
    throw error
  }
  throw new Error('expected a documentation error')
}

function alternates(html: string): string[] {
  return [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)]
    .map((match) => `${match[1]} ${match[2]}`)
}

const INDEX = '# Welcome\n\nRead the [guide](./guide.md) or [the reference](/reference).'
const GUIDE = '---\ndescription: Install the app.\n---\n\n# Guide\n\n## Install\n\nRun the installer.'
const REFERENCE = '# Reference\n\n## Every option\n\nEvery option.'
const LOCALES = {
  default: 'en',
  alternates: [
    { code: 'es', label: 'Español', navigationLabels: { Start: 'Inicio' } },
    { code: 'zh-hans', label: '简体中文', navigationLabels: { Start: '开始' } },
  ],
}

function localizedFixture(extra: Record<string, string> = {}): string {
  return fixture(
    {
      url: 'https://docs.example.test',
      navigation: [{ group: 'Start', pages: ['index', 'guide', 'reference'] }],
      locales: LOCALES,
    },
    {
      'index.md': INDEX,
      'guide.md': GUIDE,
      'reference.md': REFERENCE,
      'es/index.md': translation(INDEX, '# Bienvenida\n\nLee la [guía](./guide.md) o [la referencia](/reference).'),
      'es/guide.md': translation(GUIDE, '# Guía\n\n## Instalar\n\nEjecuta el instalador.'),
      'zh-hans/index.md': translation(INDEX, '# 欢迎\n\n阅读[指南](./guide.md)。'),
      ...extra,
    },
  )
}

describe('documentation locales', () => {
  it('emits self-canonical, reciprocal hreflang for every version of a page', () => {
    const result = buildDocumentation({ appDir: localizedFixture(), basePath: '' })
    const read = (path: string): string => readFileSync(join(result.outputDir, path), 'utf8')

    const englishGuide = read('guide/index.html')
    const spanishGuide = read('es/guide/index.html')
    expect(englishGuide).toContain('<html lang="en"')
    expect(spanishGuide).toContain('<html lang="es"')
    expect(spanishGuide).toContain('<link rel="canonical" href="https://docs.example.test/es/guide">')
    const guideCluster = [
      'en https://docs.example.test/guide',
      'es https://docs.example.test/es/guide',
      'x-default https://docs.example.test/guide',
    ]
    expect(alternates(englishGuide)).toEqual(guideCluster)
    expect(alternates(spanishGuide)).toEqual(guideCluster)

    const homeCluster = [
      'en https://docs.example.test/',
      'es https://docs.example.test/es',
      'zh-Hans https://docs.example.test/zh-hans',
      'x-default https://docs.example.test/',
    ]
    expect(alternates(read('index.html'))).toEqual(homeCluster)
    expect(alternates(read('es/index.html'))).toEqual(homeCluster)
    expect(alternates(read('zh-hans/index.html'))).toEqual(homeCluster)
    expect(read('zh-hans/index.html')).toContain('<html lang="zh-Hans"')

    // A page with one language version carries no alternates.
    expect(alternates(read('reference/index.html'))).toEqual([])

    const sitemap = read('sitemap.xml')
    expect(sitemap).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"')
    expect(sitemap).toContain('<loc>https://docs.example.test/es/guide</loc>')
    expect(sitemap).toContain(
      '<xhtml:link rel="alternate" hreflang="zh-Hans" href="https://docs.example.test/zh-hans"/>',
    )
    expect(sitemap).toContain('<url><loc>https://docs.example.test/reference</loc></url>')

    const routeDocument = JSON.parse(read('data/es/guide.json')) as {
      languageAlternates: unknown
      data: { alternates: unknown }
    }
    expect(routeDocument.languageAlternates).toHaveLength(3)
    expect(routeDocument.data.alternates).toEqual([
      { locale: 'en', route: '/guide' },
      { locale: 'es', route: '/es/guide' },
    ])
  })

  it('gives each locale its own navigation, search index, and agent indexes', () => {
    const result = buildDocumentation({ appDir: localizedFixture(), basePath: '' })
    const read = (path: string): string => readFileSync(join(result.outputDir, path), 'utf8')

    const spanish = bootstrap(read('es/guide/index.html'))
    expect(spanish.navigation).toEqual([
      {
        kind: 'group',
        label: 'Inicio',
        items: [
          { kind: 'page', route: '/es', label: 'Bienvenida' },
          { kind: 'page', route: '/es/guide', label: 'Guía' },
        ],
      },
    ])
    expect(spanish.localization).toEqual({
      locale: 'es',
      locales: [
        { code: 'en', label: 'English', prefix: '', home: '/' },
        { code: 'es', label: 'Español', prefix: 'es', home: '/es' },
        { code: 'zh-Hans', label: '简体中文', prefix: 'zh-hans', home: '/zh-hans' },
      ],
    })
    expect(bootstrap(read('guide/index.html')).localization?.locale).toBe('en')

    const routes = (path: string): string[] =>
      (JSON.parse(read(path)) as Array<{ route: string }>).map((entry) => entry.route)
    expect(routes('search.json')).toEqual(['/', '/guide', '/reference'])
    expect(routes('es/search.json')).toEqual(['/es', '/es/guide'])
    expect(routes('zh-hans/search.json')).toEqual(['/zh-hans'])
    expect(routes('assistant-index.json').every((route) => !route.startsWith('/es'))).toBe(true)

    const llms = read('llms.txt')
    expect(llms).not.toContain('/es/guide.md')
    expect(llms).toContain('## Translations\n\n- [Español](/es/llms.txt)\n- [简体中文](/zh-hans/llms.txt)')
    const spanishLlms = read('es/llms.txt')
    expect(spanishLlms).toContain('# Test Documentation (Español)')
    expect(spanishLlms).toContain('- [Guía](/es/guide.md)')
    expect(spanishLlms).toContain('- [English](/llms.txt)')
    expect(read('es/llms-full.txt')).toContain('Ejecuta el instalador.')
    expect(read('skill.md')).not.toContain('/es/')
    expect(result.manifest.routes).toContain('/es/guide')
    expect(result.manifest.resources).toContain('/es/search.json')
  })

  it('resolves references copied from the source, preferring the same-locale page', () => {
    const result = buildDocumentation({ appDir: localizedFixture(), basePath: '' })
    const spanishHome = bootstrap(readFileSync(join(result.outputDir, 'es/index.html'), 'utf8'))
    expect(spanishHome.page.html).toContain('href="/es/guide"')
    expect(spanishHome.page.html).toContain('href="/reference"')
    const chineseHome = bootstrap(readFileSync(join(result.outputDir, 'zh-hans/index.html'), 'utf8'))
    expect(chineseHome.page.html).toContain('href="/guide"')
  })

  it('keeps link-only navigation groups in translated sidebars', () => {
    const appDir = fixture(
      {
        navigation: [
          { group: 'Start', pages: ['index', 'guide'] },
          { group: 'Community', pages: [{ label: 'GitHub', href: 'https://github.com/example' }] },
        ],
        locales: {
          default: 'en',
          alternates: [{
            code: 'es',
            label: 'Español',
            navigationLabels: { Start: 'Inicio', Community: 'Comunidad', GitHub: 'GitHub' },
          }, { code: 'fr', label: 'Français' }],
        },
      },
      { 'index.md': '# Home', 'guide.md': GUIDE, 'es/guide.md': translation(GUIDE, '# Guía') },
    )
    expect(validateDocumentation(appDir).graph.localizedNavigation?.es).toEqual([
      { kind: 'group', label: 'Inicio', items: [{ kind: 'page', route: '/es/guide', label: 'Guía' }] },
      {
        kind: 'group',
        label: 'Comunidad',
        items: [{ kind: 'link', href: 'https://github.com/example', label: 'GitHub' }],
      },
    ])
    // French has no translations yet, so it needs no labels and has no sidebar.
    expect(validateDocumentation(appDir).graph.localizedNavigation?.fr).toEqual([])
  })

  it('leaves code samples in translations exactly as written', () => {
    const sample = [
      '```html',
      '<a href="/">Inicio</a> <a href="/guide">Guía</a>',
      '[guía](/guide)',
      '```',
    ].join('\n')
    const appDir = localizedFixture({
      'es/index.md': translation(
        INDEX,
        `# Bienvenida\n\nLee la [guía](/guide).\n\n${sample}\n\nEscribe \`[guía](/guide)\` en Markdown.`,
      ),
    })
    const markdown = validateDocumentation(appDir).graph.pages.find((page) => page.route === '/es')!.markdown
    expect(markdown).toContain('Lee la [guía](/es/guide).')
    expect(markdown).toContain(sample)
    expect(markdown).toContain('Escribe `[guía](/guide)` en Markdown.')
  })

  it('keeps relative links to redirects and generated pages working when copied', () => {
    const body = 'See the [old guide](./old-guide) or <a href="./old-guide#install">install</a>.'
    const appDir = fixture(
      {
        navigation: [{ group: 'Start', pages: ['index', 'guide'] }],
        redirects: { '/old-guide': '/guide' },
        locales: LOCALES,
      },
      {
        'index.md': `# Welcome\n\n${body}`,
        'guide.md': GUIDE,
        'es/index.md': translation(`# Welcome\n\n${body}`, `# Bienvenida\n\n${body}`),
      },
    )
    const markdown = validateDocumentation(appDir).graph.pages.find((page) => page.route === '/es')!.markdown
    // Resolved from the English page's route, where a reader would have resolved them.
    expect(markdown).toContain('[old guide](/old-guide)')
    expect(markdown).toContain('<a href="/old-guide#install">')
  })

  it('checks relative links in translated code samples from the source page', () => {
    const start = '# Start\n\n```md\n[old](./old)\n```'
    const appDir = fixture(
      {
        navigation: [{ group: 'Start', pages: ['index', 'agents/start'] }],
        redirects: { '/agents/old': '/agents/start' },
        locales: LOCALES,
      },
      {
        'index.md': '# Home',
        'agents/start.md': start,
        'es/agents/start.md': translation(start, '# Inicio\n\n```md\n[old](./old)\n```'),
      },
    )
    // The sample resolves to the /agents/old redirect, as on the English page.
    const markdown = validateDocumentation(appDir).graph.pages.find((page) => page.route === '/es/agents/start')!.markdown
    expect(markdown).toContain('```md\n[old](./old)\n```')
  })

  it('leaves footnotes and relative reference definitions in translations as written', () => {
    const appDir = localizedFixture({
      'es/index.md': translation(
        INDEX,
        [
          '# Bienvenida',
          '',
          'Lee la [guía][guia] o la [antigua][vieja].[^1]',
          '',
          '[guia]: /guide',
          '[vieja]: ./old-guide',
          '[^1]: Solo en beta.',
        ].join('\n'),
      ),
    })
    const markdown = validateDocumentation(appDir).graph.pages.find((page) => page.route === '/es')!.markdown
    expect(markdown).toContain('[guia]: /es/guide')
    expect(markdown).toContain('[vieja]: ./old-guide')
    expect(markdown).toContain('[^1]: Solo en beta.')
  })

  it('checks section links in translated pages against the headings they reach', () => {
    const copied = validationError(localizedFixture({
      'es/index.md': translation(INDEX, '# Bienvenida\n\nSigue los [pasos](/guide#install).\n\nVuelve al [inicio](#inicio).'),
    }))
    expect(copied.code).toBe('documentation_links_invalid')
    expect(copied.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message])).toEqual([
      [
        'translation_anchor_missing',
        '/es/guide#install: no section #install on /es/guide (translated headings get their own ids). Sections: #instalar',
      ],
      [
        'translation_anchor_missing',
        '#inicio: no section #inicio on /es (translated headings get their own ids). Sections: none',
      ],
    ])

    const result = buildDocumentation({
      appDir: localizedFixture({
        'es/index.md': translation(
          INDEX,
          '# Bienvenida\n\nSigue los [pasos](/guide#instalar) o [cada opción](/reference#every-option).' +
            '\n\nUn ejemplo, sin comprobar:\n\n```md\n[Saltar](#configure) o [paso](/guide#install)\n```',
        ),
        // Default-locale pages keep today's rules: their section links are not checked.
        'reference.md': '# Reference\n\n## Every option\n\nSee [nowhere](/guide#nowhere).',
      }),
      basePath: '',
    })
    const html = bootstrap(readFileSync(join(result.outputDir, 'es/index.html'), 'utf8')).page.html
    expect(html).toContain('href="/es/guide#instalar"')
    // An untranslated target stays English, where the section exists.
    expect(html).toContain('href="/reference#every-option"')
  })

  it('renders translated MDX from the source the graph resolved', () => {
    const NOTE_IMPORT = "import { Note } from '../components/note.js'\n\n"
    const MDX_INDEX = `${NOTE_IMPORT}${INDEX}\n\n<Note />`
    const appDir = fixture(
      {
        navigation: [{ group: 'Start', pages: ['index', 'guide', 'reference'] }],
        locales: LOCALES,
      },
      {
        'index.mdx': MDX_INDEX,
        'guide.md': GUIDE,
        'reference.md': REFERENCE,
        // The import is copied as written, relative to the source page.
        'es/index.mdx': translation(
          MDX_INDEX,
          `${NOTE_IMPORT}# Bienvenida\n\nLee la [guía](./guide.md) o [la referencia](/reference).\n\n<Note />`,
        ),
        'es/guide.md': translation(GUIDE, '# Guía\n\n## Instalar\n\nEjecuta el instalador.'),
      },
    )
    mkdirSync(join(appDir, 'components'))
    writeFileSync(join(appDir, 'components/note.js'), "export function Note() { return 'Shared note' }\n")
    const result = buildDocumentation({ appDir, basePath: '' })
    const html = readFileSync(join(result.outputDir, 'es/index.html'), 'utf8')
    const prose = html.slice(html.indexOf('data-prose="react"'))
    expect(prose).toContain('Shared note')
    expect(prose).toContain('href="/es/guide"')
    expect(prose).toContain('href="/reference"')
    expect(result.graph.pages.find((page) => page.route === '/es')?.mdxSource).toContain('](/es/guide)')
    expect(result.graph.pages.find((page) => page.route === '/guide')?.mdxSource).toBeUndefined()
  })

  it('serves a stale translation with a notice and reports it', () => {
    const appDir = localizedFixture({
      'es/guide.md': translation(GUIDE, '# Guía\n\nTexto antiguo.', '0000000000000000'),
    })
    const result = buildDocumentation({ appDir, basePath: '' })
    const stale = result.warnings.filter((warning) => warning.code === 'translation_stale')
    expect(stale).toHaveLength(1)
    expect(stale[0]!.message).toContain(sourceHash(GUIDE))
    const html = readFileSync(join(result.outputDir, 'es/guide/index.html'), 'utf8')
    expect(bootstrap(html).translation).toEqual({ sourceRoute: '/guide', stale: true })
    expect(html).toContain('documentation-translation-notice')
    // React serializes the prop name; HTML attribute names are case-insensitive.
    expect(html).toContain('href="/guide" hrefLang="en" lang="en"')
    const current = bootstrap(readFileSync(join(result.outputDir, 'es/index.html'), 'utf8'))
    expect(current.translation).toEqual({ sourceRoute: '/', stale: false })
    // The 404 page has no route of its own, so its language links go home.
    const notFound = readFileSync(join(result.outputDir, '404.html'), 'utf8')
    expect(notFound).toContain('href="/" hrefLang="en"')
    expect(notFound).not.toContain('href="/404"')

    // Line endings and a BOM don't change the hash, so a CRLF checkout agrees.
    const crlf = buildDocumentation({
      appDir: localizedFixture({ 'guide.md': `\uFEFF${GUIDE.replace(/\n/g, '\r\n')}` }),
      basePath: '',
    })
    expect(crlf.warnings.filter((warning) => warning.code === 'translation_stale')).toEqual([])
  })

  it('rejects translations that cannot be paired, hashed, or labelled', () => {
    const failure = (extra: Record<string, string>, config?: Record<string, unknown>): DocumentationError => {
      const appDir = config
        ? fixture(config, { 'index.md': INDEX, 'guide.md': GUIDE, 'reference.md': REFERENCE, ...extra })
        : localizedFixture(extra)
      try {
        validateDocumentation(appDir)
      } catch (error) {
        if (error instanceof DocumentationError) return error
        throw error
      }
      throw new Error('expected a documentation error')
    }

    const missing = failure({ 'es/guide.md': '# Guía' })
    expect(missing.code).toBe('documentation_translation_invalid')
    expect(missing.diagnostics[0]).toMatchObject({
      code: 'translation_source_hash_missing',
      message: expect.stringContaining(`sourceHash: "${sourceHash(GUIDE)}"`),
    })

    expect(failure({ 'es/missing.md': translation('', '# Nada') }).diagnostics[0]?.code)
      .toBe('translation_orphan')

    expect(failure({ 'es/guide.mdx': translation(GUIDE, '# Guía') }).code)
      .toBe('documentation_route_collision')

    const slug = failure({ 'es/guide.md': `---\nslug: guia\nsourceHash: "${sourceHash(GUIDE)}"\n---\n# Guía` })
    expect(slug.diagnostics[0]?.code).toBe('translation_frontmatter_inherited')

    const prefixed = failure({ 'reference.md': `---\nslug: /es/reference\n---\n${REFERENCE}` })
    expect(prefixed.code).toBe('documentation_route_reserved')

    const french = {
      navigation: [{ group: 'Start', pages: ['index', 'guide', 'reference'] }],
      locales: { default: 'en', alternates: [{ code: 'fr', label: 'Français' }] },
    }
    const unlabelled = failure({ 'fr/index.md': translation(INDEX, '# Bienvenue') }, french)
    expect(unlabelled.diagnostics).toEqual([
      expect.objectContaining({
        code: 'translation_navigation_label_missing',
        message: 'locales: add navigationLabels["Start"] for fr',
      }),
    ])
    // A locale with no translated page in a group needs no label for it.
    expect(() => validateDocumentation(
      fixture(french, { 'index.md': INDEX, 'guide.md': GUIDE, 'reference.md': REFERENCE }),
    )).not.toThrow()
  })

  it('accepts only hreflang-compatible, unique locale codes', () => {
    const configError = (alternates: unknown[]): DocumentationError => {
      try {
        validateDocumentation(fixture({ locales: { default: 'en', alternates } }, { 'index.md': '# Home' }))
      } catch (error) {
        if (error instanceof DocumentationError) return error
        throw error
      }
      throw new Error('expected a documentation error')
    }
    expect(configError([{ code: 'es-419', label: 'Español' }]).code).toBe('documentation_config_invalid')
    expect(configError([{ code: 'EN', label: 'English' }]).diagnostics[0]?.message)
      .toContain('locale codes must be unique')
    const graph = validateDocumentation(
      fixture(
        { locales: { default: { code: 'en', label: 'English (US)' }, alternates: [{ code: 'PT-br', label: 'Português' }] } },
        { 'index.md': '# Home' },
      ),
    ).graph
    expect(graph.config.locales?.default).toEqual({ code: 'en', label: 'English (US)' })
    expect(graph.config.locales?.alternates[0]).toMatchObject({ code: 'pt-BR', prefix: 'pt-br' })
  })

  it('leaves a site without locales on the single-language output', () => {
    const appDir = fixture(
      { url: 'https://docs.example.test', navigation: [{ group: 'Start', pages: ['index', 'guide', 'es/notes'] }] },
      { 'index.md': INDEX.replace(' or [the reference](/reference)', ''), 'guide.md': GUIDE, 'es/notes.md': '# Notes' },
    )
    const result = buildDocumentation({ appDir, basePath: '' })
    const read = (path: string): string => readFileSync(join(result.outputDir, path), 'utf8')
    const html = read('guide/index.html')
    expect(html).toContain('<html lang="en"')
    expect(alternates(html)).toEqual([])
    const data = bootstrap(html)
    expect(data.localization).toBeUndefined()
    expect(data.alternates).toBeUndefined()
    expect(read('sitemap.xml')).not.toContain('xhtml')
    expect(read('llms.txt')).not.toContain('Translations')
    expect(JSON.parse(read('data/guide.json'))).not.toHaveProperty('languageAlternates')
    // Without locales, a folder named like a locale is ordinary content.
    expect(result.manifest.routes).toContain('/es/notes')
  })
})
