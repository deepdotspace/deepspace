import { buildSync } from 'esbuild'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { version as sdkPackageVersion } from '../../package.json'
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
import { validateDocumentation } from './graph'
import { buildCustomDocumentationRuntime, runtimeEntry } from './custom-runtime'
import { readBundledFont, resolveDocumentationFonts } from './fonts'
import { DocumentationOutput } from './output'
import { artifactPathsForRoute } from './routing'
import { documentationPublicPath, normalizeDocumentationBasePath } from './routing'
import { encodeNativeDocumentationPath, isNativeDocumentationResourcePath } from './resource-path'
import { createDocumentationSkillArtifacts } from './skill'
import {
  createPageRuntime,
  createNotFoundPage,
  renderDocumentationFavicon,
  renderPage,
  renderRedirect,
  DOCUMENTATION_CSS,
  DOCUMENTATION_THEME_BOOTSTRAP,
} from './template'
import {
  DOCUMENTATION_MANIFEST_VERSION,
  DocumentationError,
  type DocumentationBuildManifest,
  type DocumentationBuildResult,
} from './types'

export interface BuildDocumentationOptions {
  appDir: string
  outputDir?: string
  baseUrl?: string
  /** Public mount on the ordinary app host. Defaults to `/docs`. */
  basePath?: string
}

export function buildDocumentation(options: BuildDocumentationOptions): DocumentationBuildResult {
  const validation = validateDocumentation(options.appDir)
  const outputDir = options.outputDir ? resolve(options.outputDir) : validation.outputDir
  const output = new DocumentationOutput(outputDir, validation.appDir, validation.sourceDir)
  const basePath = normalizeDocumentationBasePath(options.basePath ?? '/docs')
  const renderConfig = options.baseUrl
    ? { ...validation.graph.config, url: options.baseUrl }
    : validation.graph.config

  const write = output.write.bind(output)

  const customRuntime = buildCustomDocumentationRuntime(validation, basePath)
  if (customRuntime) {
    for (const asset of customRuntime.browserAssets) write(`assets/${asset.path}`, asset.content)
  }

  for (const page of validation.graph.pages) {
    const artifactPaths = artifactPathsForRoute(page.route)
    const renderOptions = {
      config: renderConfig,
      basePath,
      page,
      pages: validation.graph.pages,
      navigation: validation.graph.navigation,
    }
    const runtime = createPageRuntime(renderOptions)
    write(artifactPaths.html, renderPage(renderOptions, customRuntime ? {
      customStylesheets: customRuntime.stylesheets,
      markup: customRuntime.render(runtime.data, page.route),
      runtimeModule: true,
      runtimeScript: documentationPublicPath(basePath, '/assets/documentation-custom-runtime.js'),
    } : {}, runtime))
    write(artifactPaths.data, stableJson(runtime.document))
    write(artifactPaths.markdown, pageMarkdown(page, basePath))
  }
  for (const [from, to] of Object.entries(validation.graph.config.redirects)) {
    write(artifactPathsForRoute(from).html, renderRedirect(to, basePath))
  }

  const notFoundPage = createNotFoundPage()
  const notFoundOptions = {
    config: renderConfig,
    basePath,
    page: notFoundPage,
    pages: [notFoundPage],
    navigation: validation.graph.navigation,
  }
  const notFoundRuntime = createPageRuntime(notFoundOptions)
  write('404.html', renderPage(notFoundOptions, customRuntime ? {
    customStylesheets: customRuntime.stylesheets,
    markup: customRuntime.render(notFoundRuntime.data, notFoundPage.route),
    runtimeModule: true,
    runtimeScript: documentationPublicPath(basePath, '/assets/documentation-custom-runtime.js'),
  } : {}, notFoundRuntime))
  write('assets/documentation.css', DOCUMENTATION_CSS.trimStart())
  write('assets/documentation-theme.js', DOCUMENTATION_THEME_BOOTSTRAP)
  for (const font of resolveDocumentationFonts(renderConfig.theme, basePath)) {
    if (font.bundled) write(`assets/fonts/${font.bundled.fileName}`, readBundledFont(font.bundled))
  }
  if (!renderConfig.theme.favicon) write('assets/favicon.svg', renderDocumentationFavicon(renderConfig.theme))
  if (!customRuntime) write('assets/documentation-runtime.js', buildDocumentationRuntime().trimStart())
  write('search.json', stableJson(createSearchEntries(validation.graph.pages)))
  write('assistant-index.json', stableJson(createAssistantChunks(validation.graph.pages)))
  const openApiOperations = validation.graph.pages.flatMap((page) =>
    page.openapi ? [{ route: page.route, ...page.openapi }] : [],
  )
  if (openApiOperations.length > 0) write('openapi.json', stableJson(openApiOperations))
  const machinePages = pagesInNavigationOrder(validation.graph.pages, validation.graph.navigation)
  write('llms.txt', renderLlmsIndex(machinePages, validation.graph.config.name, basePath))
  write('llms-full.txt', renderLlmsFull(machinePages, validation.graph.config.name, basePath))
  const skill = createDocumentationSkillArtifacts(validation.graph, renderConfig.url, basePath)
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

  const resources = [...output.files]
    .filter((file) => isNativeDocumentationResourcePath(`/${file}`))
    .map((file) => encodeNativeDocumentationPath(`/${file}`))
    .sort()
  const outputHash = output.hash()
  const manifest: DocumentationBuildManifest = {
    version: DOCUMENTATION_MANIFEST_VERSION,
    sourceHash: validation.graph.sourceHash,
    outputHash,
    sdkVersion: sdkPackageVersion,
    name: validation.graph.config.name,
    pageCount: validation.graph.pages.length,
    routes: [
      ...validation.graph.pages.map((page) => page.route),
      ...Object.keys(validation.graph.config.redirects),
    ].map(encodeNativeDocumentationPath).sort(),
    resources,
    assistant: validation.graph.config.assistant,
    mcp: validation.graph.config.mcp,
    domains: validation.graph.config.domains,
    basePath,
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
 * Published packages ship a pre-bundled browser runtime beside `dist/documentation.js`.
 * Source checkouts compile the same entry on demand so SDK tests and local CLI
 * development exercise the real hydration code rather than a test-only shim.
 */
function buildDocumentationRuntime(): string {
  const entry = runtimeEntry('documentation-runtime.js', 'runtime/auto-client.tsx')
  if (entry.endsWith('.js')) return readFileSync(entry, 'utf8')

  const result = buildSync({
    entryPoints: [entry],
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
    throw new DocumentationError('Unable to compile the documentation browser runtime', 'documentation_runtime_build_failed')
  }
  return output
}
