import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import sdkPackage from '../../../package.json'
import { buildDocumentation } from '../build'
import { validateDocumentation } from '../graph'
import { parseMarkdown } from '../markdown'
import { DEFAULT_DOCUMENTATION_CONTEXTUAL_ACTIONS, DocumentationError } from '../types'

function fixture(config: Record<string, unknown>, pages: Record<string, string>): string {
  const appDir = mkdtempSync(join(tmpdir(), 'deepspace-documentation-'))
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

describe('DeepSpace documentation compiler', () => {
  it('builds human, search, SEO, and LLM artifacts from one graph', () => {
    const appDir = fixture(
      {
        url: 'https://test-app.spacestest.com/docs',
        description: 'A deterministic documentation fixture.',
        navigation: [{ group: 'Start', pages: ['index', 'guide'] }],
        redirects: { '/old-guide': '/guide' },
        assistant: { access: 'public', suggestions: ['How do I start?'] },
      },
      {
        'index.mdx':
          '---\ntitle: Welcome\ndescription: Begin here.\n---\n\n# Welcome\n\nRead the [guide](./guide.mdx) or [the same guide][guide-ref].\n\n[guide-ref]: /guide\n\n<Note title="Same commit">Built with the app.</Note>',
        'guide.mdx': '# Guide\n\n## Install\n\n```bash\nnpx deepspace deploy\n```',
      },
    )

    const result = buildDocumentation({ appDir })

    expect(result.manifest.pageCount).toBe(2)
    expect(result.manifest.sdkVersion).toBe(sdkPackage.version)
    expect(result.manifest.assistant.access).toBe('public')
    expect(result.manifest.mcp.access).toBe('public')
    expect(result.manifest.routes).toContain('/old-guide')
    expect(result.manifest.resources).toContain('/guide.md')
    expect(result.manifest.resources).toContain('/assets/documentation-custom-runtime.js')
    expect(result.manifest.resources).not.toContain('/old-guide/index.html')
    expect(result.graph.config.contextual.actions).toEqual(DEFAULT_DOCUMENTATION_CONTEXTUAL_ACTIONS)
    expect(result.files).toContain('index.html')
    expect(result.files).toContain('guide/index.html')
    expect(result.files).toContain('data/index.json')
    expect(result.files).toContain('data/guide.json')
    expect(result.files).toContain('guide.md')
    expect(result.files).toContain('search.json')
    expect(result.files).toContain('assistant-index.json')
    expect(result.files).toContain('assets/documentation-custom-runtime.js')
    expect(result.files).toContain('llms.txt')
    expect(result.files).toContain('llms-full.txt')
    expect(result.files).toContain('skill.md')
    expect(result.files).toContain('.well-known/agent-skills/test-documentation/skill.md')
    expect(result.files).toContain('.well-known/agent-skills/index.json')
    expect(result.files).toContain('old-guide/index.html')

    const home = readFileSync(join(result.outputDir, 'index.html'), 'utf8')
    const homeMarkdown = readFileSync(join(result.outputDir, 'index.md'), 'utf8')
    const llmsFull = readFileSync(join(result.outputDir, 'llms-full.txt'), 'utf8')
    expect(home).toContain('documentation-callout-note')
    expect(home).toContain('href="/docs/guide"')
    expect(home.match(/<h1\b/g)).toHaveLength(1)
    expect(homeMarkdown).toContain('[guide](/docs/guide)')
    expect(homeMarkdown).toContain('[guide-ref]: /docs/guide')
    expect(llmsFull).toContain('[guide](/docs/guide)')
    expect(llmsFull).toContain('Source: /docs/index.md')
    expect(home).toContain('id="deepspace-documentation-assistant-launcher-input"')
    expect(home).toContain('class="documentation-app has-assistant"')
    expect(home).not.toContain('aria-controls="deepspace-documentation-assistant"')
    expect(home).toContain('id="deepspace-documentation-root"')
    expect(home).toContain('id="deepspace-documentation-data"')
    expect(home).toContain(`Built with deepspace ${sdkPackage.version}`)
    expect(home).toContain('aria-label="Test Documentation home"')
    expect(home).not.toContain('Test Documentation documentation')
    expect(home).toContain('src="/docs/assets/documentation-custom-runtime.js"')
    const documentationCss = readFileSync(
      join(result.outputDir, 'assets', 'documentation.css'),
      'utf8',
    )
    // The launcher sticks inside the reading column instead of being fixed to
    // the viewport, so the pagination needs no reserved space beneath it.
    expect(documentationCss).not.toContain(
      '.documentation-app.has-assistant .documentation-pagination',
    )
    expect(documentationCss).toContain('.documentation-launcher-dock { position: sticky;')
    expect(documentationCss).toContain(
      '.documentation-launcher-dock + .documentation-pagination { margin-top: 0; }',
    )
    expect(documentationCss).toContain(
      '.documentation-app.is-assistant-open .documentation-main { margin-right: var(--documentation-assistant-width); }',
    )
    expect(readFileSync(join(result.outputDir, 'old-guide/index.html'), 'utf8')).toContain(
      'url=/docs/guide',
    )
    expect(readFileSync(join(result.outputDir, 'assistant-index.json'), 'utf8')).toContain(
      '"route": "/guide#install"',
    )
    const skill = readFileSync(join(result.outputDir, 'skill.md'), 'utf8')
    expect(skill).toContain('name: "test-documentation"')
    expect(skill).toContain('https://test-app.spacestest.com/docs/llms.txt')
    expect(skill).toContain('https://test-app.spacestest.com/docs/mcp')
    expect(skill).toContain('[Guide](https://test-app.spacestest.com/docs/guide.md)')
    const discovery = JSON.parse(
      readFileSync(join(result.outputDir, '.well-known/agent-skills/index.json'), 'utf8'),
    ) as { $schema: string; skills: Array<{ digest: string; url: string }> }
    expect(discovery.$schema).toBe('https://schemas.agentskills.io/discovery/0.2.0/schema.json')
    expect(discovery.skills[0]?.url).toBe(
      '/docs/.well-known/agent-skills/test-documentation/skill.md',
    )
    expect(discovery.skills[0]?.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    const guideData = JSON.parse(
      readFileSync(join(result.outputDir, 'data', 'guide.json'), 'utf8'),
    ) as { data: Record<string, unknown>; title: string }
    expect(guideData.title).toBe('Guide · Test Documentation')
    expect(guideData.data).not.toHaveProperty('config')
    expect(guideData.data).not.toHaveProperty('navigation')
  })

  it('ships a syntactically valid browser runtime and highlights supported code', () => {
    const appDir = fixture({}, { 'index.md': '# Runtime' })
    const result = buildDocumentation({ appDir })
    const runtime = readFileSync(join(result.outputDir, 'assets/documentation-runtime.js'), 'utf8')
    expect(() => new Function(runtime)).not.toThrow()
    const parsed = parseMarkdown('```ts\nconst answer: number = 42\n```', 'code.md')
    expect(parsed.html).toContain('language-ts hljs')
    expect(parsed.html).toContain('hljs-keyword')
  })

  it('renders an ordered AI-native page-action menu without clipped rail ornament', () => {
    const appDir = fixture(
      {
        assistant: { access: 'public' },
        mcp: { access: 'public' },
        contextual: {
          actions: [...DEFAULT_DOCUMENTATION_CONTEXTUAL_ACTIONS],
        },
      },
      { 'index.md': '# Actions' },
    )

    const result = buildDocumentation({ appDir })
    expect(result.graph.config.contextual.actions).toEqual(DEFAULT_DOCUMENTATION_CONTEXTUAL_ACTIONS)
    const home = readFileSync(join(result.outputDir, 'index.html'), 'utf8')
    expect(home).toContain('aria-label="Page actions"')
    expect(home).toContain('Copy page')
    expect(home).toContain('Copy page as Markdown for LLMs')
    expect(home).toContain('View as Markdown')
    expect(home).toContain('Ask about this page')
    expect(home).toContain('Open in ChatGPT')
    expect(home).toContain('Open in Claude')
    expect(home).toContain('Copy MCP server URL')
    expect(home).toContain('Copy MCP install command')
    expect(home).toContain('Connect to Cursor')
    expect(home).toContain('Connect to VS Code')
    expect(home).not.toContain('documentation-context-orbit')
    expect(readFileSync(join(result.outputDir, '404.html'), 'utf8')).not.toContain(
      'aria-label="Page actions"',
    )
  })

  it('rejects duplicate native page actions', () => {
    const appDir = fixture(
      { contextual: { actions: ['copy', 'copy'] } },
      { 'index.md': '# Duplicate actions' },
    )
    expect(() => validateDocumentation(appDir)).toThrowError(DocumentationError)
  })

  it('normalizes high-value appearance settings into the native theme contract', () => {
    const appDir = fixture(
      {
        appearance: { default: 'light', strict: true },
        background: { color: { light: '#f7f8fb', dark: '#090b12' }, decoration: 'grid' },
        fonts: {
          family: 'Inter',
          heading: { family: 'Space Grotesk', weight: 650 },
        },
        styling: { codeblocks: 'system', eyebrows: 'breadcrumbs' },
      },
      { 'index.md': '# Themed' },
    )

    const result = buildDocumentation({ appDir })
    expect(result.graph.config.theme).toMatchObject({
      background: '#f7f8fb',
      backgroundDark: '#090b12',
      backgroundDecoration: 'grid',
      bodyFont: { family: 'Inter' },
      codeBlockMode: 'system',
      defaultMode: 'light',
      eyebrowStyle: 'breadcrumbs',
      headingFont: { family: 'Space Grotesk', weight: 650 },
      strictMode: true,
    })
    const home = readFileSync(join(result.outputDir, 'index.html'), 'utf8')
    expect(home).toContain('data-theme-strict="true"')
    expect(home).toContain('data-code-mode="system"')
    expect(home).toContain('--documentation-font-body:Inter')
    expect(home).toContain('--documentation-font-heading:Space Grotesk')
    expect(home.indexOf('href="/docs/assets/documentation.css"')).toBeLessThan(
      home.indexOf('--documentation-font-body:Inter'),
    )
  })

  it('themes reading density through one data attribute and token block', () => {
    const compact = buildDocumentation({
      appDir: fixture({ theme: { density: 'compact' } }, { 'index.md': '# Dense' }),
    })
    expect(compact.graph.config.theme.density).toBe('compact')
    expect(readFileSync(join(compact.outputDir, 'index.html'), 'utf8')).toContain(
      'data-density="compact"',
    )
    const css = readFileSync(join(compact.outputDir, 'assets', 'documentation.css'), 'utf8')
    expect(css).toContain('--documentation-font-size: 17px')
    expect(css).toContain('--documentation-line-height: 1.65')
    expect(css).toContain('--documentation-content-width: 720px')
    expect(css).toContain('--documentation-reader-pad: 62px 52px 96px')
    expect(css).toContain(':root[data-density="compact"]')
    expect(css).toContain('--documentation-sidebar-width: 264px')
    expect(css).toContain('font-size: var(--documentation-font-size)')
    expect(css).toContain('minmax(0, var(--documentation-content-width))')
    expect(css).toContain('padding: var(--documentation-reader-pad)')

    const comfortable = buildDocumentation({
      appDir: fixture({}, { 'index.md': '# Roomy' }),
    })
    expect(comfortable.graph.config.theme.density).toBeUndefined()
    expect(readFileSync(join(comfortable.outputDir, 'index.html'), 'utf8')).toContain(
      'data-density="comfortable"',
    )

    expect(() =>
      validateDocumentation(fixture({ theme: { density: 'cozy' } }, { 'index.md': '# Cozy' })),
    ).toThrowError(DocumentationError)
  })

  it('honors native strict mode before the legacy appearance fallback', () => {
    const appDir = fixture(
      {
        theme: { strictMode: true },
        appearance: { strict: false },
      },
      { 'index.md': '# Strict theme' },
    )

    const result = buildDocumentation({ appDir })
    expect(result.graph.config.theme.strictMode).toBe(true)
    const home = readFileSync(join(result.outputDir, 'index.html'), 'utf8')
    expect(home).toContain('data-theme-strict="true"')
    expect(home).not.toContain('aria-label="Theme preference"')
  })

  it('self-hosts variable body and monospace fonts with preload hints', () => {
    const appDir = fixture(
      {
        fonts: {
          body: {
            family: 'Geist',
            source: 'fonts/geist.woff2',
            weight: '100 900',
            format: 'woff2',
          },
          mono: {
            family: 'Geist Mono',
            source: 'fonts/geist-mono.woff2',
            weight: '100 900',
            format: 'woff2',
          },
        },
      },
      { 'index.md': '# Typography' },
    )
    mkdirSync(join(appDir, 'documentation', 'fonts'), { recursive: true })
    writeFileSync(join(appDir, 'documentation', 'fonts', 'geist.woff2'), 'font bytes')
    writeFileSync(join(appDir, 'documentation', 'fonts', 'geist-mono.woff2'), 'mono font bytes')

    const result = buildDocumentation({ appDir })
    const home = readFileSync(join(result.outputDir, 'index.html'), 'utf8')
    expect(home).toContain('font-family:"Geist"')
    expect(home).toContain('font-weight:100 900')
    expect(home).toContain('--documentation-font-mono:Geist Mono')
    expect(home).toContain('rel="preload" href="/docs/media/fonts/geist.woff2" as="font"')
    expect(result.files).toContain('media/fonts/geist-mono.woff2')
    // Configured slots replace the bundled defaults rather than loading both.
    expect(result.files).not.toContain('assets/fonts/inter-variable.woff2')
    expect(result.files).not.toContain('assets/fonts/geist-mono-variable.woff2')
  })

  it('ships the bundled Inter and Geist Mono faces when the theme configures no fonts', () => {
    const result = buildDocumentation({ appDir: fixture({}, { 'index.md': '# Typography' }) })
    const home = readFileSync(join(result.outputDir, 'index.html'), 'utf8')

    expect(result.files).toContain('assets/fonts/inter-variable.woff2')
    expect(result.files).toContain('assets/fonts/geist-mono-variable.woff2')
    expect(home).toContain('font-family:"Inter";src:url("/docs/assets/fonts/inter-variable.woff2")')
    expect(home).toContain(
      'font-family:"Geist Mono";src:url("/docs/assets/fonts/geist-mono-variable.woff2")',
    )
    expect(home).toContain('font-weight:100 900')
    expect(home).toContain('rel="preload" href="/docs/assets/fonts/inter-variable.woff2" as="font"')
    expect(
      readFileSync(join(result.outputDir, 'assets/fonts/inter-variable.woff2'))
        .subarray(0, 4)
        .toString(),
    ).toBe('wOF2')
  })

  it('emits default tab and share metadata when the theme configures none', () => {
    const result = buildDocumentation({ appDir: fixture({}, { 'index.md': '# Metadata' }) })
    const home = readFileSync(join(result.outputDir, 'index.html'), 'utf8')

    expect(result.files).toContain('assets/favicon.svg')
    expect(home).toContain('<link rel="icon" href="/docs/assets/favicon.svg">')
    expect(home).toContain('<meta name="twitter:card" content="summary">')
    expect(home).toContain('<meta name="theme-color" media="(prefers-color-scheme: dark)"')
    expect(readFileSync(join(result.outputDir, 'assets/favicon.svg'), 'utf8')).toContain('#635bff')
  })

  it('renders code groups as accessible synchronized tab panels', () => {
    const parsed = parseMarkdown(
      [
        '<CodeGroup>',
        '```bash npm',
        'npm install deepspace',
        '```',
        '```bash pnpm',
        'pnpm add deepspace',
        '```',
        '</CodeGroup>',
      ].join('\n'),
      'code-group.mdx',
    )

    expect(parsed.html).toContain('class="documentation-code-group"')
    expect(parsed.html).toContain('data-tab-group')
    expect(parsed.html).toContain('data-tab-title="npm"')
    expect(parsed.html).toContain('data-tab-title="pnpm"')
  })

  it('can bind canonical metadata to the environment-specific documentation host', () => {
    const appDir = fixture({}, { 'index.md': '# Home', 'guide.md': '# Guide' })
    const result = buildDocumentation({ appDir, baseUrl: 'https://test-app.spacestest.com/docs' })
    const guide = readFileSync(join(result.outputDir, 'guide/index.html'), 'utf8')
    expect(guide).toContain(
      '<link rel="canonical" href="https://test-app.spacestest.com/docs/guide">',
    )
    expect(readFileSync(join(result.outputDir, 'sitemap.xml'), 'utf8')).toContain(
      'https://test-app.spacestest.com/docs/guide',
    )
  })

  it('projects logical root links into the public Markdown mount', () => {
    const appDir = fixture(
      {},
      {
        'index.md': '# Home',
        'guide.md': '# Guide\n\n[Home](/)\n\n[Reference home]: /',
      },
    )
    const result = buildDocumentation({ appDir })
    const markdown = readFileSync(join(result.outputDir, 'guide.md'), 'utf8')

    expect(markdown).toContain('[Home](/docs/)')
    expect(markdown).toContain('[Reference home]: /docs/')
  })

  it('compiles root-relative navigation for a custom documentation host', () => {
    const appDir = fixture(
      { domains: ['docs.example.com'] },
      { 'index.md': '# Home\n\n[Read the guide](/guide)', 'guide.md': '# Guide' },
    )
    const result = buildDocumentation({
      appDir,
      basePath: '',
      baseUrl: 'https://docs.example.com',
    })
    const home = readFileSync(join(result.outputDir, 'index.html'), 'utf8')
    const markdown = readFileSync(join(result.outputDir, 'index.md'), 'utf8')
    expect(result.manifest.domains).toEqual(['docs.example.com'])
    expect(home).toContain('href="/guide"')
    expect(markdown).toContain('[Read the guide](/guide)')
    expect(home).toContain('href="/assets/documentation.css"')
    expect(home).not.toContain('href="/docs/')
    expect(home).toContain('<link rel="canonical" href="https://docs.example.com/">')
    expect(readFileSync(join(result.outputDir, 'sitemap.xml'), 'utf8')).toContain(
      'https://docs.example.com/guide',
    )
    expect(readFileSync(join(result.outputDir, 'skill.md'), 'utf8')).toContain(
      'https://docs.example.com/llms.txt',
    )
  })

  it('rejects multiple custom hosts for one canonical compiled surface', () => {
    const appDir = fixture(
      { domains: ['docs.example.com', 'docs-alias.example.com'] },
      { 'index.md': '# Home' },
    )
    expect(() => validateDocumentation(appDir)).toThrow(DocumentationError)
  })

  it('produces deterministic hashes for unchanged sources', () => {
    const appDir = fixture({}, { 'index.md': '# Stable\n\nExactly one source.' })
    const first = buildDocumentation({ appDir })
    const second = buildDocumentation({ appDir })
    expect(second.manifest.sourceHash).toBe(first.manifest.sourceHash)
    expect(second.manifest.outputHash).toBe(first.manifest.outputHash)
  })

  it('rejects unknown and tool-loop-incompatible assistant models at build time', () => {
    for (const model of ['made-up-model', 'gpt-oss-120b']) {
      const appDir = fixture(
        { assistant: { access: 'public', model } },
        { 'index.md': '# Model policy' },
      )
      expect(() => validateDocumentation(appDir)).toThrowError(DocumentationError)
    }
  })

  it('includes media bytes in the source hash', () => {
    const appDir = fixture({}, { 'index.md': '# Media\n\n![Pixel](./pixel.png)' })
    const mediaPath = join(appDir, 'documentation', 'pixel.png')
    writeFileSync(mediaPath, 'first image bytes')
    const first = validateDocumentation(appDir).graph.sourceHash
    writeFileSync(mediaPath, 'second image bytes')
    expect(validateDocumentation(appDir).graph.sourceHash).not.toBe(first)
  })

  it('rejects authored routes that could escape the output directory', () => {
    for (const slug of [
      '../..',
      '/guide/../admin',
      '/%2e%2e/escape',
      '/%252e%252e/escape',
      String.raw`/guide\..\escape`,
    ]) {
      const appDir = fixture(
        {},
        {
          'index.md': `---\nslug: ${JSON.stringify(slug)}\n---\n\n# Unsafe route`,
        },
      )
      writeFileSync(join(appDir, 'index.html'), 'app shell')

      expect(() => buildDocumentation({ appDir })).toThrowError(DocumentationError)
      expect(readFileSync(join(appDir, 'index.html'), 'utf8')).toBe('app shell')
    }
  })

  it('rejects OpenAPI sources outside the app, including symlink escapes', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'deepspace-openapi-outside-'))
    const outsideSource = join(outsideDir, 'openapi.yaml')
    writeFileSync(outsideSource, 'openapi: 3.1.0\ninfo: { title: Outside }\npaths: {}\n')

    const lexicalEscape = fixture(
      { openapi: { source: '../openapi.yaml' } },
      { 'index.md': '# Home' },
    )
    expect(() => validateDocumentation(lexicalEscape)).toThrowError(DocumentationError)

    const symlinkEscape = fixture(
      { openapi: { source: 'documentation/openapi.yaml' } },
      { 'index.md': '# Home' },
    )
    symlinkSync(outsideSource, join(symlinkEscape, 'documentation', 'openapi.yaml'))
    expect(() => validateDocumentation(symlinkEscape)).toThrowError(DocumentationError)
  })

  it('keeps plain Markdown non-executable and rejects active HTML', () => {
    expect(() =>
      parseMarkdown('import Widget from "./Widget"\n\n# Unsafe', 'unsafe.mdx'),
    ).toThrowError(DocumentationError)
    expect(() =>
      parseMarkdown('# Unsafe\n\n<img src="x" onerror="run()">', 'unsafe.mdx'),
    ).toThrowError(DocumentationError)
  })

  it('executes trusted MDX and an optional root documentation.tsx without weakening the agent corpus', () => {
    const appDir = fixture(
      { assistant: { access: 'public' } },
      {
        'index.mdx': [
          '---',
          'title: Custom documentation',
          '---',
          '',
          'import Counter from "../Counter"',
          'import BareWidget from "tiny-widget"',
          'import AliasBadge from "@/components/AliasBadge"',
          '',
          '# Custom documentation',
          '',
          'Authored prose stays searchable.',
          '',
          '<Counter>',
          'Agent-visible command: `npx deepspace deploy`.',
          '</Counter>',
          '<BareWidget />',
          '<AliasBadge />',
          '',
          '```ts',
          'import Counter from "./Counter"',
          '```',
          '',
          '<CodeGroup>',
          '```bash npm',
          'npm install deepspace',
          '```',
          '```bash pnpm',
          'pnpm add deepspace',
          '```',
          '</CodeGroup>',
        ].join('\n'),
      },
    )
    writeFileSync(
      join(appDir, 'Counter.tsx'),
      'import { useState, type ReactNode } from "react"\n' +
        'const implementationSecret = "not-agent-content"\n' +
        'export default function Counter({ children }: { children: ReactNode }) { const [count, setCount] = useState(0); return <div>{children}<button onClick={() => setCount(count + 1)}>Count from MDX: {count}{implementationSecret.slice(0, 0)}</button></div> }\n',
    )
    writeFileSync(
      join(appDir, 'tsconfig.json'),
      '{\n  // scaffold-style alias\n  "compilerOptions": { "paths": { "@/*": ["./src/*"] } }\n}\n',
    )
    mkdirSync(join(appDir, 'src', 'components'), { recursive: true })
    writeFileSync(
      join(appDir, 'src', 'components', 'AliasBadge.tsx'),
      'export default function AliasBadge() { return <span data-alias-badge="true">Alias import</span> }\n',
    )
    mkdirSync(join(appDir, 'node_modules', 'tiny-widget'), { recursive: true })
    writeFileSync(
      join(appDir, 'node_modules', 'tiny-widget', 'package.json'),
      '{"name":"tiny-widget","type":"module","exports":"./index.js"}\n',
    )
    writeFileSync(
      join(appDir, 'node_modules', 'tiny-widget', 'index.js'),
      'import { createElement } from "react"\nexport default function BareWidget() { return createElement("span", { "data-bare-widget": "true" }, "Bare package import") }\n',
    )
    writeFileSync(
      join(appDir, 'documentation-custom.css'),
      '.custom-documentation-site { --custom-documentation: true; }\n',
    )
    writeFileSync(
      join(appDir, 'documentation.tsx'),
      'import { DefaultDocumentation, type DocumentationSiteProps } from "deepspace/documentation/react"\n' +
        'import "./documentation-custom.css"\n' +
        'export default function Site(props: DocumentationSiteProps) { return <div className="custom-documentation-site" data-custom-site="true"><DefaultDocumentation {...props} /></div> }\n',
    )

    const result = buildDocumentation({ appDir })
    const home = readFileSync(join(result.outputDir, 'index.html'), 'utf8')
    const search = readFileSync(join(result.outputDir, 'search.json'), 'utf8')
    const assistant = readFileSync(join(result.outputDir, 'assistant-index.json'), 'utf8')

    expect(home).toContain('data-custom-site="true"')
    expect(home).toContain('Count from MDX:')
    expect(home).toContain('Bare package import')
    expect(home).toContain('data-alias-badge="true"')
    expect(home).toContain('./Counter')
    expect(home).not.toContain(appDir)
    expect(home).toContain('data-tab-title="npm"')
    expect(home).toContain('data-tab-title="pnpm"')
    expect(home).toContain('href="/docs/assets/documentation-custom-runtime.css"')
    expect(result.files).toContain('assets/documentation-custom-runtime.js')
    expect(result.files).toContain('assets/documentation-custom-runtime.css')
    expect(
      result.files.some((file) => /^assets\/documentation-page-[A-Z0-9]+\.js$/.test(file)),
    ).toBe(true)
    expect(search).toContain('Authored prose stays searchable.')
    expect(search).toContain('npx deepspace deploy')
    expect(search).not.toContain('implementationSecret')
    expect(assistant).toContain('npx deepspace deploy')
    expect(assistant).not.toContain('not-agent-content')
    const notFound = readFileSync(join(result.outputDir, '404.html'), 'utf8')
    expect(notFound).toContain('data-custom-site="true"')
    expect(notFound).toContain('src="/docs/assets/documentation-custom-runtime.js"')
    expect(notFound).not.toContain('src="/docs/assets/documentation-runtime.js"')
    expect(buildDocumentation({ appDir }).manifest.outputHash).toBe(result.manifest.outputHash)
  })

  it('treats indented component code fences as code, not executable MDX', () => {
    const parsed = parseMarkdown(
      [
        '<Steps>',
        '  <Step title="Add a route">',
        '    ```ts',
        "    import { Hono } from 'hono'",
        '    export const app = new Hono()',
        '    ```',
        '  </Step>',
        '</Steps>',
      ].join('\n'),
      'steps.mdx',
    )
    expect(parsed.html).toContain('documentation-steps')
    expect(parsed.html).toContain('language-ts hljs')
  })

  it('keeps fenced H1 examples while the shell owns the first authored H1', () => {
    const appDir = fixture(
      {},
      {
        'index.md': '# Page title\n\n```md\n# Example heading\n```\n\n## Section',
      },
    )
    const result = buildDocumentation({ appDir })
    const page = result.graph.pages[0]
    expect(page?.title).toBe('Page title')
    expect(page?.markdown).not.toContain('# Page title')
    expect(page?.markdown).toContain('# Example heading')
    expect(page?.headings.map((heading) => heading.text)).toEqual(['Section'])
  })

  it('rejects public pages omitted from explicit navigation', () => {
    const appDir = fixture(
      { navigation: ['index'] },
      { 'index.md': '# Home', 'orphan.md': '# Orphan' },
    )
    expect(() => validateDocumentation(appDir)).toThrowError(/missing from navigation/)
  })

  it('accepts internal links covered by a validated redirect', () => {
    const appDir = fixture(
      { redirects: { '/renamed': '/guide' } },
      { 'index.md': '# Home\n\nSee [the old route](/renamed).', 'guide.md': '# Guide' },
    )
    expect(validateDocumentation(appDir).graph.config.redirects['/renamed']).toBe('/guide')
  })

  it('generates OpenAPI operation pages and only enables an explicit playground', () => {
    const appDir = fixture(
      {
        openapi: {
          source: 'documentation/openapi.yaml',
          route: '/reference',
          playground: true,
          baseUrl: 'https://api.example.test',
        },
      },
      {
        'index.md': '# API home',
        'openapi.yaml': [
          'openapi: 3.1.0',
          'info:',
          '  title: Example API',
          'paths:',
          '  /widgets/{id}:',
          '    get:',
          '      operationId: getWidget',
          '      summary: Get a widget',
          '      parameters:',
          '        - name: id',
          '          in: path',
          '          required: true',
          '          schema: { type: string }',
          '      responses:',
          "        '200':",
          '          description: Widget',
        ].join('\n'),
      },
    )

    const result = buildDocumentation({ appDir })
    expect(result.manifest.routes).toContain('/reference/getwidget')
    expect(result.files).toContain('openapi.json')
    const operation = result.graph.pages.find((page) => page.kind === 'openapi')?.openapi
    expect(operation?.codeSamples.map((sample) => sample.label)).toEqual([
      'cURL',
      'Python',
      'JavaScript',
      'Go',
    ])
    const javascript = operation?.codeSamples.find(
      (sample) => sample.language === 'javascript',
    )?.code
    expect(() => new Function(`return async () => { ${javascript} }`)).not.toThrow()
    const html = readFileSync(join(result.outputDir, 'reference/getwidget/index.html'), 'utf8')
    expect(html).toContain('data-playground')
    expect(html).toContain('data-tab-persist="code"')
  })

  it('uses operation-level OpenAPI parameters to override matching path parameters', () => {
    const appDir = fixture(
      {
        openapi: {
          source: 'documentation/openapi.yaml',
          route: '/reference',
          baseUrl: 'https://api.example.test',
        },
      },
      {
        'index.md': '# API home',
        'openapi.yaml': [
          'openapi: 3.1.0',
          'info:',
          '  title: Example API',
          'paths:',
          '  /widgets/{id}:',
          '    parameters:',
          '      - name: id',
          '        in: path',
          '        required: true',
          '        example: old',
          '        schema: { type: string }',
          '    get:',
          '      operationId: getWidget',
          '      parameters:',
          '        - name: id',
          '          in: path',
          '          required: true',
          '          example: new',
          '          description: Operation override',
          '          schema: { type: string }',
          '      responses:',
          "        '200':",
          '          description: Widget',
        ].join('\n'),
      },
    )

    const result = buildDocumentation({ appDir })
    const operation = result.graph.pages.find((page) => page.kind === 'openapi')?.openapi
    expect(operation?.parameters).toEqual([
      expect.objectContaining({
        name: 'id',
        in: 'path',
        example: 'new',
        description: 'Operation override',
      }),
    ])
    expect(operation?.codeSamples.find((sample) => sample.language === 'curl')?.code).toContain(
      'https://api.example.test/widgets/new',
    )
  })

  it('normalizes Mintlify API settings into deterministic request samples', () => {
    const appDir = fixture(
      {
        api: {
          playground: { display: 'interactive' },
          examples: {
            languages: ['curl', 'javascript', 'python', 'go'],
            defaults: 'required',
          },
        },
        openapi: {
          source: 'documentation/openapi.yaml',
          route: '/reference',
          baseUrl: 'https://api.example.test',
        },
      },
      {
        'index.md': '# API home',
        'openapi.yaml': [
          'openapi: 3.1.0',
          'info:',
          '  title: Example API',
          'components:',
          '  securitySchemes:',
          '    bearerAuth:',
          '      type: http',
          '      scheme: bearer',
          '  schemas:',
          '    WidgetInput:',
          '      type: object',
          '      required: [name]',
          '      properties:',
          '        name: { type: string, example: Orbit }',
          '        note: { type: string }',
          'paths:',
          '  /widgets/{id}:',
          '    post:',
          '      operationId: updateWidget',
          '      summary: Update a widget',
          '      security:',
          '        - bearerAuth: []',
          '      parameters:',
          '        - name: id',
          '          in: path',
          '          required: true',
          '          schema: { type: string }',
          '        - name: verbose',
          '          in: query',
          '          schema: { type: boolean }',
          '      requestBody:',
          '        content:',
          '          application/json:',
          '            schema:',
          "              $ref: '#/components/schemas/WidgetInput'",
          '      x-codeSamples:',
          '        - lang: javascript',
          '          label: Widget SDK',
          '          source: \'await client.widgets.update("example-id", { name: "Orbit" })\'',
          '      responses:',
          "        '200':",
          '          description: Widget',
        ].join('\n'),
      },
    )

    const result = buildDocumentation({ appDir })
    expect(result.warnings).toEqual([])
    expect(result.graph.config.openapi[0]).toMatchObject({
      playground: true,
      examples: {
        languages: ['curl', 'javascript', 'python', 'go'],
        defaults: 'required',
        autogenerate: true,
      },
    })
    const operation = result.graph.pages.find((page) => page.kind === 'openapi')?.openapi
    expect(operation?.codeSamples).toHaveLength(4)
    expect(operation?.codeSamples[0]).toMatchObject({
      label: 'Widget SDK',
      generated: false,
    })
    const curl = operation?.codeSamples.find((sample) => sample.language === 'curl')?.code ?? ''
    expect(curl).toContain('https://api.example.test/widgets/example-id')
    expect(curl).toContain('Authorization: Bearer <token>')
    expect(curl).toContain('"name": "Orbit"')
    expect(curl).not.toContain('verbose=')
    expect(curl).not.toContain('"note"')

    const html = readFileSync(join(result.outputDir, 'reference/updatewidget/index.html'), 'utf8')
    expect(html).toContain('data-tab-persist="code"')
    expect(html).toContain('data-tab-title="Widget SDK"')
    expect(html).toContain('data-tab-title="cURL"')
    expect(html).toContain('data-tab-title="Python"')
    expect(html).toContain('data-tab-title="Go"')
  })

  it('copies local media under the reserved documentation asset root', () => {
    const appDir = fixture(
      {},
      {
        'index.md': '# Media\n\n![Diagram](./diagram.svg)',
        'café guide.md': '# Encoded route',
      },
    )
    writeFileSync(
      join(appDir, 'documentation', 'diagram.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    )
    writeFileSync(join(appDir, 'documentation', 'café logo wide.png'), 'png')
    const result = buildDocumentation({ appDir })
    expect(result.files).toContain('media/diagram.svg')
    expect(result.files).toContain('media/café logo wide.png')
    expect(result.files).toContain('café guide/index.html')
    expect(result.manifest.routes).toContain('/caf%C3%A9%20guide')
    expect(result.manifest.resources).toContain('/media/caf%C3%A9%20logo%20wide.png')
    expect(result.manifest.resources).toContain('/caf%C3%A9%20guide.md')
    expect(readFileSync(join(result.outputDir, 'index.html'), 'utf8')).toContain(
      'src="/docs/media/diagram.svg"',
    )
  })

  it('rejects executable files masquerading as documentation media', () => {
    const appDir = fixture(
      {},
      {
        'index.md': '# Media\n\n[Unsafe payload](./payload.html)',
        'payload.html': '<script>window.top.location = "https://example.test"</script>',
      },
    )

    expect(() => buildDocumentation({ appDir })).toThrowError(/unsupported documentation media/i)
  })

  it('sanitizes active SVG media before publication', () => {
    const appDir = fixture({}, { 'index.md': '# SVG\n\n![Logo](./logo.svg)' })
    writeFileSync(
      join(appDir, 'documentation', 'logo.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><path d="M0 0h1v1z"/><text x="2" y="4" font-family="system-ui" font-size="2">Safe wordmark</text></svg>',
    )

    const result = buildDocumentation({ appDir })
    const svg = readFileSync(join(result.outputDir, 'media', 'logo.svg'), 'utf8')
    expect(svg).toContain('<path')
    expect(svg).toContain(
      '<text x="2" y="4" font-family="system-ui" font-size="2">Safe wordmark</text>',
    )
    expect(svg).not.toContain('script')
    expect(svg).not.toContain('onload')
  })

  it('normalizes a useful Mintlify config subset without changing content', () => {
    const appDir = fixture(
      {
        theme: 'palm',
        colors: { primary: '#0A2540' },
        logo: { light: '/logo/light.svg', dark: '/logo/dark.svg' },
        favicon: '/favicon.ico',
        navigation: { groups: [{ group: 'Start', pages: ['index'] }] },
        navbar: {
          links: [{ label: 'GitHub', href: 'https://github.com/example' }],
          primary: { type: 'button', label: 'Start', href: '/' },
        },
        footer: { socials: { github: 'https://github.com/example' } },
        seo: { metatags: { 'msvalidate.01': 'verification-token' } },
      },
      { 'index.mdx': '# Native migration' },
    )
    mkdirSync(join(appDir, 'documentation', 'logo'), { recursive: true })
    writeFileSync(join(appDir, 'documentation', 'logo', 'light.svg'), '<svg/>')
    writeFileSync(join(appDir, 'documentation', 'logo', 'dark.svg'), '<svg/>')
    writeFileSync(join(appDir, 'documentation', 'favicon.ico'), 'icon')

    const result = validateDocumentation(appDir)
    expect(result.graph.config.theme).toMatchObject({
      accent: '#0A2540',
      logo: '/media/logo/light.svg',
      logoDark: '/media/logo/dark.svg',
      favicon: '/media/favicon.ico',
    })
    // The Mintlify theme string maps onto the native surface; nothing survives it.
    expect(result.graph.config.theme).not.toHaveProperty('preset')
    expect(result.graph.config.links.map((link) => link.label)).toEqual(['GitHub', 'Start'])
    expect(result.graph.config.footer).toEqual([
      { label: 'Github', href: 'https://github.com/example' },
    ])
    expect(result.graph.config.seo.metaTags).toEqual({ 'msvalidate.01': 'verification-token' })
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'mintlify_theme_normalized',
      'mintlify_navigation_normalized',
    ])
    const build = buildDocumentation({ appDir })
    expect(readFileSync(join(build.outputDir, 'index.html'), 'utf8')).toContain(
      '<meta name="msvalidate.01" content="verification-token">',
    )
  })

  it('reports unsupported migration keys and rejects unsafe chrome links', () => {
    const warned = fixture({ topbarCtaButton: { label: 'Legacy CTA' } }, { 'index.md': '# Home' })
    expect(validateDocumentation(warned).warnings).toContainEqual(
      expect.objectContaining({
        code: 'unsupported_config_key',
        message: expect.stringContaining('topbarCtaButton'),
      }),
    )

    const typoTheme = fixture({ theme: { densty: 'compact' } }, { 'index.md': '# Home' })
    expect(validateDocumentation(typoTheme).warnings).toContainEqual(
      expect.objectContaining({
        code: 'unsupported_config_key',
        message: expect.stringContaining("'theme.densty'"),
      }),
    )

    const unsafe = fixture(
      { footer: [{ label: 'Unsafe', href: 'javascript:alert(1)' }] },
      { 'index.md': '# Home' },
    )
    expect(() => validateDocumentation(unsafe)).toThrowError(/Unsafe footer link/)
  })
})
