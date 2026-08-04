import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDocs } from '../build'
import { validateDocs } from '../graph'
import { parseMarkdown } from '../markdown'
import { DEFAULT_DOCS_CONTEXTUAL_ACTIONS, DocsError } from '../types'

function fixture(config: Record<string, unknown>, pages: Record<string, string>): string {
  const appDir = mkdtempSync(join(tmpdir(), 'deepspace-docs-'))
  mkdirSync(join(appDir, 'docs'), { recursive: true })
  writeFileSync(
    join(appDir, 'docs.json'),
    `${JSON.stringify({ name: 'Test Docs', ...config }, null, 2)}\n`,
  )
  for (const [path, content] of Object.entries(pages)) {
    const destination = join(appDir, 'docs', path)
    mkdirSync(join(destination, '..'), { recursive: true })
    writeFileSync(destination, content)
  }
  return appDir
}

describe('DeepSpace docs compiler', () => {
  it('builds human, search, SEO, and LLM artifacts from one graph', () => {
    const appDir = fixture(
      {
        url: 'https://docs.test-app.spacestest.com',
        description: 'A deterministic documentation fixture.',
        navigation: [{ group: 'Start', pages: ['index', 'guide'] }],
        redirects: { '/old-guide': '/guide' },
        assistant: { access: 'public', suggestions: ['How do I start?'] },
      },
      {
        'index.mdx':
          '---\ntitle: Welcome\ndescription: Begin here.\n---\n\n# Welcome\n\nRead the [guide](./guide.mdx).\n\n<Note title="Same commit">Built with the app.</Note>',
        'guide.mdx': '# Guide\n\n## Install\n\n```bash\nnpx deepspace docs build\n```',
      },
    )

    const result = buildDocs({ appDir })

    expect(result.manifest.pageCount).toBe(2)
    expect(result.manifest.assistant.access).toBe('public')
    expect(result.manifest.mcp.access).toBe('public')
    expect(result.graph.config.contextual.actions).toEqual(DEFAULT_DOCS_CONTEXTUAL_ACTIONS)
    expect(result.files).toContain('index.html')
    expect(result.files).toContain('guide/index.html')
    expect(result.files).toContain('data/index.json')
    expect(result.files).toContain('data/guide.json')
    expect(result.files).toContain('guide.md')
    expect(result.files).toContain('search.json')
    expect(result.files).toContain('assistant-index.json')
    expect(result.files).toContain('assets/docs-custom-runtime.js')
    expect(result.files).toContain('llms.txt')
    expect(result.files).toContain('llms-full.txt')
    expect(result.files).toContain('skill.md')
    expect(result.files).toContain('.well-known/skills/test-docs/SKILL.md')
    expect(result.files).toContain('.well-known/skills/index.json')
    expect(result.files).toContain('.well-known/agent-skills/test-docs/skill.md')
    expect(result.files).toContain('.well-known/agent-skills/index.json')
    expect(result.files).toContain('old-guide/index.html')

    const home = readFileSync(join(result.outputDir, 'index.html'), 'utf8')
    expect(home).toContain('docs-callout-note')
    expect(home).toContain('href="/guide"')
    expect(home).toContain('id="deepspace-docs-assistant-launcher-input"')
    expect(home).not.toContain('aria-controls="deepspace-docs-assistant"')
    expect(home).toContain('id="deepspace-docs-root"')
    expect(home).toContain('id="deepspace-docs-data"')
    expect(home).toContain('src="/_docs/assets/docs-custom-runtime.js"')
    expect(readFileSync(join(result.outputDir, 'old-guide/index.html'), 'utf8')).toContain(
      'url=/guide',
    )
    expect(readFileSync(join(result.outputDir, 'assistant-index.json'), 'utf8')).toContain(
      '"route": "/guide#install"',
    )
    const skill = readFileSync(join(result.outputDir, 'skill.md'), 'utf8')
    expect(skill).toContain('name: "test-docs"')
    expect(skill).toContain('https://docs.test-app.spacestest.com/llms.txt')
    expect(skill).toContain('https://docs.test-app.spacestest.com/mcp')
    expect(skill).toContain('[Guide](https://docs.test-app.spacestest.com/guide.md)')
    const discovery = JSON.parse(
      readFileSync(join(result.outputDir, '.well-known/agent-skills/index.json'), 'utf8'),
    ) as { $schema: string; skills: Array<{ digest: string; url: string }> }
    expect(discovery.$schema).toBe('https://schemas.agentskills.io/discovery/0.2.0/schema.json')
    expect(discovery.skills[0]?.url).toBe('/.well-known/agent-skills/test-docs/skill.md')
    expect(discovery.skills[0]?.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    const guideData = JSON.parse(
      readFileSync(join(result.outputDir, 'data', 'guide.json'), 'utf8'),
    ) as { data: Record<string, unknown>; title: string }
    expect(guideData.title).toBe('Guide · Test Docs')
    expect(guideData.data).not.toHaveProperty('config')
    expect(guideData.data).not.toHaveProperty('navigation')
  })

  it('ships a syntactically valid browser runtime and highlights supported code', () => {
    const appDir = fixture({}, { 'index.md': '# Runtime' })
    const result = buildDocs({ appDir })
    const runtime = readFileSync(join(result.outputDir, 'assets/docs-runtime.js'), 'utf8')
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
          actions: [...DEFAULT_DOCS_CONTEXTUAL_ACTIONS],
        },
      },
      { 'index.md': '# Actions' },
    )

    const result = buildDocs({ appDir })
    expect(result.graph.config.contextual.actions).toEqual(DEFAULT_DOCS_CONTEXTUAL_ACTIONS)
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
    expect(home).not.toContain('docs-context-orbit')
  })

  it('rejects duplicate native page actions', () => {
    const appDir = fixture(
      { contextual: { actions: ['copy', 'copy'] } },
      { 'index.md': '# Duplicate actions' },
    )
    expect(() => validateDocs(appDir)).toThrowError(DocsError)
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

    const result = buildDocs({ appDir })
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
    expect(home).toContain('--docs-font-body:Inter')
    expect(home).toContain('--docs-font-heading:Space Grotesk')
    expect(home.indexOf('href="/_docs/assets/docs.css"')).toBeLessThan(
      home.indexOf('--docs-font-body:Inter'),
    )
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
    mkdirSync(join(appDir, 'docs', 'fonts'), { recursive: true })
    writeFileSync(join(appDir, 'docs', 'fonts', 'geist.woff2'), 'font bytes')
    writeFileSync(join(appDir, 'docs', 'fonts', 'geist-mono.woff2'), 'mono font bytes')

    const result = buildDocs({ appDir })
    const home = readFileSync(join(result.outputDir, 'index.html'), 'utf8')
    expect(home).toContain('font-family:"Geist"')
    expect(home).toContain('font-weight:100 900')
    expect(home).toContain('--docs-font-mono:Geist Mono')
    expect(home).toContain('rel="preload" href="/_docs/media/fonts/geist.woff2" as="font"')
    expect(result.files).toContain('media/fonts/geist-mono.woff2')
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

    expect(parsed.html).toContain('class="docs-code-group"')
    expect(parsed.html).toContain('data-tab-group')
    expect(parsed.html).toContain('data-tab-title="npm"')
    expect(parsed.html).toContain('data-tab-title="pnpm"')
  })

  it('can bind canonical metadata to the environment-specific docs host', () => {
    const appDir = fixture({}, { 'index.md': '# Home', 'guide.md': '# Guide' })
    const result = buildDocs({ appDir, baseUrl: 'https://docs.test-app.spacestest.com' })
    const guide = readFileSync(join(result.outputDir, 'guide/index.html'), 'utf8')
    expect(guide).toContain(
      '<link rel="canonical" href="https://docs.test-app.spacestest.com/guide">',
    )
    expect(readFileSync(join(result.outputDir, 'sitemap.xml'), 'utf8')).toContain(
      'https://docs.test-app.spacestest.com/guide',
    )
  })

  it('produces deterministic hashes for unchanged sources', () => {
    const appDir = fixture({}, { 'index.md': '# Stable\n\nExactly one source.' })
    const first = buildDocs({ appDir })
    const second = buildDocs({ appDir })
    expect(second.manifest.sourceHash).toBe(first.manifest.sourceHash)
    expect(second.manifest.outputHash).toBe(first.manifest.outputHash)
  })

  it('rejects unknown and tool-loop-incompatible assistant models at build time', () => {
    for (const model of ['made-up-model', 'gpt-oss-120b']) {
      const appDir = fixture(
        { assistant: { access: 'public', model } },
        { 'index.md': '# Model policy' },
      )
      expect(() => validateDocs(appDir)).toThrowError(DocsError)
    }
  })

  it('includes media bytes in the source hash', () => {
    const appDir = fixture({}, { 'index.md': '# Media\n\n![Pixel](./pixel.png)' })
    const mediaPath = join(appDir, 'docs', 'pixel.png')
    writeFileSync(mediaPath, 'first image bytes')
    const first = validateDocs(appDir).graph.sourceHash
    writeFileSync(mediaPath, 'second image bytes')
    expect(validateDocs(appDir).graph.sourceHash).not.toBe(first)
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

      expect(() => buildDocs({ appDir })).toThrowError(DocsError)
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
    expect(() => validateDocs(lexicalEscape)).toThrowError(DocsError)

    const symlinkEscape = fixture(
      { openapi: { source: 'docs/openapi.yaml' } },
      { 'index.md': '# Home' },
    )
    symlinkSync(outsideSource, join(symlinkEscape, 'docs', 'openapi.yaml'))
    expect(() => validateDocs(symlinkEscape)).toThrowError(DocsError)
  })

  it('keeps plain Markdown non-executable and rejects active HTML', () => {
    expect(() =>
      parseMarkdown('import Widget from "./Widget"\n\n# Unsafe', 'unsafe.mdx'),
    ).toThrowError(DocsError)
    expect(() =>
      parseMarkdown('# Unsafe\n\n<img src="x" onerror="run()">', 'unsafe.mdx'),
    ).toThrowError(DocsError)
  })

  it('executes trusted MDX and an optional root docs.tsx without weakening the agent corpus', () => {
    const appDir = fixture(
      { assistant: { access: 'public' } },
      {
        'index.mdx': [
          '---',
          'title: Custom docs',
          '---',
          '',
          'import Counter from "../Counter"',
          'import BareWidget from "tiny-widget"',
          '',
          '# Custom docs',
          '',
          'Authored prose stays searchable.',
          '',
          '<Counter>',
          'Agent-visible command: `npx deepspace docs build`.',
          '</Counter>',
          '<BareWidget />',
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
    mkdirSync(join(appDir, 'node_modules', 'tiny-widget'), { recursive: true })
    writeFileSync(
      join(appDir, 'node_modules', 'tiny-widget', 'package.json'),
      '{"name":"tiny-widget","type":"module","exports":"./index.js"}\n',
    )
    writeFileSync(
      join(appDir, 'node_modules', 'tiny-widget', 'index.js'),
      'import { createElement } from "react"\nexport default function BareWidget() { return createElement("span", { "data-bare-widget": "true" }, "Bare package import") }\n',
    )
    writeFileSync(join(appDir, 'docs-custom.css'), '.custom-docs-site { --custom-docs: true; }\n')
    writeFileSync(
      join(appDir, 'docs.tsx'),
      'import { DefaultDocs, type DocsSiteProps } from "deepspace/docs/react"\n' +
        'import "./docs-custom.css"\n' +
        'export default function Site(props: DocsSiteProps) { return <div className="custom-docs-site" data-custom-site="true"><DefaultDocs {...props} /></div> }\n',
    )

    const result = buildDocs({ appDir })
    const home = readFileSync(join(result.outputDir, 'index.html'), 'utf8')
    const search = readFileSync(join(result.outputDir, 'search.json'), 'utf8')
    const assistant = readFileSync(join(result.outputDir, 'assistant-index.json'), 'utf8')

    expect(home).toContain('data-custom-site="true"')
    expect(home).toContain('Count from MDX:')
    expect(home).toContain('Bare package import')
    expect(home).toContain('./Counter')
    expect(home).not.toContain(appDir)
    expect(home).toContain('data-tab-title="npm"')
    expect(home).toContain('data-tab-title="pnpm"')
    expect(home).toContain('href="/_docs/assets/docs-custom-runtime.css"')
    expect(result.files).toContain('assets/docs-custom-runtime.js')
    expect(result.files).toContain('assets/docs-custom-runtime.css')
    expect(result.files.some((file) => /^assets\/docs-page-[A-Z0-9]+\.js$/.test(file))).toBe(true)
    expect(search).toContain('Authored prose stays searchable.')
    expect(search).toContain('npx deepspace docs build')
    expect(search).not.toContain('implementationSecret')
    expect(assistant).toContain('npx deepspace docs build')
    expect(assistant).not.toContain('not-agent-content')
    const notFound = readFileSync(join(result.outputDir, '404.html'), 'utf8')
    expect(notFound).toContain('data-custom-site="true"')
    expect(notFound).toContain('src="/_docs/assets/docs-custom-runtime.js"')
    expect(notFound).not.toContain('src="/_docs/assets/docs-runtime.js"')
    expect(buildDocs({ appDir }).manifest.outputHash).toBe(result.manifest.outputHash)
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
    expect(parsed.html).toContain('docs-steps')
    expect(parsed.html).toContain('language-ts hljs')
  })

  it('rejects public pages omitted from explicit navigation', () => {
    const appDir = fixture(
      { navigation: ['index'] },
      { 'index.md': '# Home', 'orphan.md': '# Orphan' },
    )
    expect(() => validateDocs(appDir)).toThrowError(/missing from navigation/)
  })

  it('accepts internal links covered by a validated redirect', () => {
    const appDir = fixture(
      { redirects: { '/renamed': '/guide' } },
      { 'index.md': '# Home\n\nSee [the old route](/renamed).', 'guide.md': '# Guide' },
    )
    expect(validateDocs(appDir).graph.config.redirects['/renamed']).toBe('/guide')
  })

  it('generates OpenAPI operation pages and only enables an explicit playground', () => {
    const appDir = fixture(
      {
        openapi: {
          source: 'docs/openapi.yaml',
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

    const result = buildDocs({ appDir })
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
          source: 'docs/openapi.yaml',
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

    const result = buildDocs({ appDir })
    const operation = result.graph.pages.find((page) => page.kind === 'openapi')?.openapi
    expect(operation?.parameters).toEqual([
      expect.objectContaining({
        name: 'id',
        in: 'path',
        example: 'new',
        description: 'Operation override',
      }),
    ])
    expect(operation?.codeSamples.find((sample) => sample.language === 'curl')?.code)
      .toContain('https://api.example.test/widgets/new')
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
          source: 'docs/openapi.yaml',
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

    const result = buildDocs({ appDir })
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

  it('copies local media under the reserved docs asset root', () => {
    const appDir = fixture({}, { 'index.md': '# Media\n\n![Diagram](./diagram.svg)' })
    writeFileSync(join(appDir, 'docs', 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const result = buildDocs({ appDir })
    expect(result.files).toContain('media/diagram.svg')
    expect(readFileSync(join(result.outputDir, 'index.html'), 'utf8')).toContain(
      'src="/_docs/media/diagram.svg"',
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

    expect(() => buildDocs({ appDir })).toThrowError(/unsupported documentation media/i)
  })

  it('sanitizes active SVG media before publication', () => {
    const appDir = fixture({}, { 'index.md': '# SVG\n\n![Logo](./logo.svg)' })
    writeFileSync(
      join(appDir, 'docs', 'logo.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><path d="M0 0h1v1z"/><text x="2" y="4" font-family="system-ui" font-size="2">Safe wordmark</text></svg>',
    )

    const result = buildDocs({ appDir })
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
    mkdirSync(join(appDir, 'docs', 'logo'), { recursive: true })
    writeFileSync(join(appDir, 'docs', 'logo', 'light.svg'), '<svg/>')
    writeFileSync(join(appDir, 'docs', 'logo', 'dark.svg'), '<svg/>')
    writeFileSync(join(appDir, 'docs', 'favicon.ico'), 'icon')

    const result = validateDocs(appDir)
    expect(result.graph.config.theme).toMatchObject({
      preset: 'palm',
      accent: '#0A2540',
      logo: '/_docs/media/logo/light.svg',
      logoDark: '/_docs/media/logo/dark.svg',
      favicon: '/_docs/media/favicon.ico',
    })
    expect(result.graph.config.links.map((link) => link.label)).toEqual(['GitHub', 'Start'])
    expect(result.graph.config.footer).toEqual([
      { label: 'Github', href: 'https://github.com/example' },
    ])
    expect(result.graph.config.seo.metaTags).toEqual({ 'msvalidate.01': 'verification-token' })
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'mintlify_theme_normalized',
      'mintlify_navigation_normalized',
    ])
    const build = buildDocs({ appDir })
    expect(readFileSync(join(build.outputDir, 'index.html'), 'utf8')).toContain(
      '<meta name="msvalidate.01" content="verification-token">',
    )
  })

  it('reports unsupported migration keys and rejects unsafe chrome links', () => {
    const warned = fixture({ topbarCtaButton: { label: 'Legacy CTA' } }, { 'index.md': '# Home' })
    expect(validateDocs(warned).warnings).toContainEqual(
      expect.objectContaining({
        code: 'unsupported_config_key',
        message: expect.stringContaining('topbarCtaButton'),
      }),
    )

    const unsafe = fixture(
      { footer: [{ label: 'Unsafe', href: 'javascript:alert(1)' }] },
      { 'index.md': '# Home' },
    )
    expect(() => validateDocs(unsafe)).toThrowError(/Unsafe footer link/)
  })
})
