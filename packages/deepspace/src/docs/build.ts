import { buildSync } from 'esbuild'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createAssistantChunks,
  createSearchEntries,
  pageMarkdown,
  pagesInNavigationOrder,
  renderLlmsFull,
  renderLlmsIndex,
  renderRobots,
  renderSitemap,
  stableJson,
} from './artifacts'
import { validateDocs } from './graph'
import { buildCustomDocsRuntime } from './custom-runtime'
import { DocsOutput } from './output'
import { artifactPathsForRoute } from './routing'
import { createDocsSkillArtifacts } from './skill'
import {
  createPageRuntime,
  createNotFoundPage,
  renderPage,
  renderRedirect,
  DOCS_CSS,
  DOCS_THEME_BOOTSTRAP,
} from './template'
import {
  DOCS_MANIFEST_VERSION,
  DocsError,
  type DocsBuildManifest,
  type DocsBuildResult,
} from './types'

export interface BuildDocsOptions {
  appDir: string
  outputDir?: string
  baseUrl?: string
}

export function buildDocs(options: BuildDocsOptions): DocsBuildResult {
  const validation = validateDocs(options.appDir)
  const outputDir = options.outputDir ? resolve(options.outputDir) : validation.outputDir
  const output = new DocsOutput(outputDir, validation.appDir, validation.sourceDir)
  const renderConfig = options.baseUrl
    ? { ...validation.graph.config, url: options.baseUrl }
    : validation.graph.config

  const write = output.write.bind(output)

  const customRuntime = buildCustomDocsRuntime(validation)
  if (customRuntime) {
    for (const asset of customRuntime.browserAssets) write(`assets/${asset.path}`, asset.content)
  }

  for (const page of validation.graph.pages) {
    const artifactPaths = artifactPathsForRoute(page.route)
    const renderOptions = {
      config: renderConfig,
      page,
      pages: validation.graph.pages,
      navigation: validation.graph.navigation,
    }
    const runtime = createPageRuntime(renderOptions)
    write(artifactPaths.html, renderPage(renderOptions, customRuntime ? {
      customStylesheets: customRuntime.stylesheets,
      markup: customRuntime.render(runtime.data, page.route),
      runtimeModule: true,
      runtimeScript: '/_docs/assets/docs-custom-runtime.js',
    } : {}, runtime))
    write(artifactPaths.data, stableJson(runtime.document))
    write(artifactPaths.markdown, pageMarkdown(page))
  }
  for (const [from, to] of Object.entries(validation.graph.config.redirects)) {
    write(artifactPathsForRoute(from).html, renderRedirect(to))
  }

  const notFoundPage = createNotFoundPage()
  const notFoundOptions = {
    config: renderConfig,
    page: notFoundPage,
    pages: [notFoundPage],
    navigation: validation.graph.navigation,
  }
  const notFoundRuntime = createPageRuntime(notFoundOptions)
  write('404.html', renderPage(notFoundOptions, customRuntime ? {
    customStylesheets: customRuntime.stylesheets,
    markup: customRuntime.render(notFoundRuntime.data, notFoundPage.route),
    runtimeModule: true,
    runtimeScript: '/_docs/assets/docs-custom-runtime.js',
  } : {}, notFoundRuntime))
  write('assets/docs.css', DOCS_CSS.trimStart())
  write('assets/docs-theme.js', DOCS_THEME_BOOTSTRAP)
  if (!customRuntime) write('assets/docs-runtime.js', buildDocsRuntime().trimStart())
  write('search.json', stableJson(createSearchEntries(validation.graph.pages)))
  write('assistant-index.json', stableJson(createAssistantChunks(validation.graph.pages)))
  const openApiOperations = validation.graph.pages.flatMap((page) =>
    page.openapi ? [{ route: page.route, ...page.openapi }] : [],
  )
  if (openApiOperations.length > 0) write('openapi.json', stableJson(openApiOperations))
  const machinePages = pagesInNavigationOrder(validation.graph.pages, validation.graph.navigation)
  write('llms.txt', renderLlmsIndex(machinePages, validation.graph.config.name))
  write('llms-full.txt', renderLlmsFull(machinePages, validation.graph.config.name))
  const skill = createDocsSkillArtifacts(validation.graph, renderConfig.url)
  write('skill.md', skill.markdown)
  write(`.well-known/skills/${skill.name}/SKILL.md`, skill.markdown)
  write('.well-known/skills/index.json', stableJson(skill.legacyIndex))
  write(`.well-known/agent-skills/${skill.name}/skill.md`, skill.markdown)
  write('.well-known/agent-skills/index.json', stableJson(skill.discoveryIndex))
  write('sitemap.xml', renderSitemap(validation.graph.pages, renderConfig.url))
  write('robots.txt', renderRobots(renderConfig.url, renderConfig.seo.noindex))
  output.copyMedia(
    validation.sourceDir,
    new Set(
      validation.graph.pages
        .filter((page) => page.kind === 'openapi')
        .map((page) => resolve(page.sourcePath)),
    ),
  )

  const outputHash = output.hash()
  const manifest: DocsBuildManifest = {
    version: DOCS_MANIFEST_VERSION,
    sourceHash: validation.graph.sourceHash,
    outputHash,
    name: validation.graph.config.name,
    pageCount: validation.graph.pages.length,
    routes: validation.graph.pages.map((page) => page.route),
    assistant: validation.graph.config.assistant,
    mcp: validation.graph.config.mcp,
  }
  write('manifest.json', stableJson(manifest))

  return {
    ...validation,
    outputDir,
    manifest,
    files: [...output.files].sort(),
  }
}

/**
 * Published packages ship a pre-bundled browser runtime beside `dist/docs.js`.
 * Source checkouts compile the same entry on demand so SDK tests and local CLI
 * development exercise the real hydration code rather than a test-only shim.
 */
function buildDocsRuntime(): string {
  const bundledPath = fileURLToPath(new URL('./docs-runtime.js', import.meta.url))
  if (existsSync(bundledPath)) return readFileSync(bundledPath, 'utf8')

  const sourcePath = fileURLToPath(new URL('./runtime/auto-client.tsx', import.meta.url))
  const result = buildSync({
    entryPoints: [sourcePath],
    bundle: true,
    write: false,
    minify: true,
    platform: 'browser',
    format: 'iife',
    target: ['es2022'],
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const output = result.outputFiles?.[0]?.text
  if (!output) {
    throw new DocsError('Unable to compile the docs browser runtime', 'docs_runtime_build_failed')
  }
  return output
}
