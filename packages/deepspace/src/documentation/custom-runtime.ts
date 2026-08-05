import { compileSync } from '@mdx-js/mdx'
import { parse as parseJavaScript } from 'acorn'
import { buildSync, type BuildOptions, type BuildResult, type OutputFile } from 'esbuild'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rewriteLocalReferences } from './graph'
import { stripFirstMarkdownH1 } from './markdown'
import { mdxCompileOptions } from './mdx'
import { documentationPublicPath, publicDocumentationReferences } from './routing'
import { errorMessage } from './text'
import { DocumentationError, type DocumentationRuntimeData, type DocumentationValidationResult } from './types'

export interface CustomDocumentationRuntime {
  browserAssets: Array<{ path: string; content: string }>
  stylesheets: string[]
  render(data: DocumentationRuntimeData, route: string): string
}

interface JavaScriptNode {
  type: string
  start?: number
  end?: number
  source?: JavaScriptNode
  value?: unknown
  [key: string]: unknown
}

export function buildCustomDocumentationRuntime(
  validation: DocumentationValidationResult,
  basePath: string,
): CustomDocumentationRuntime | null {
  const sitePath = resolve(validation.appDir, 'documentation.tsx')
  const mdxPages = validation.graph.pages.filter((page) => page.sourceFormat === 'mdx')
  if (!existsSync(sitePath) && mdxPages.length === 0) return null

  const temporaryDir = mkdtempSync(join(tmpdir(), 'deepspace-documentation-runtime-'))
  try {
    const compiledPages = mdxPages.map((page, index) => {
      const source = readFileSync(page.sourcePath, 'utf8')
      const rewritten = rewriteLocalReferences(
        source,
        page.relativePath,
        validation.sourceDir,
        page.sourcePath,
      )
      const compiled = compileSync(
        publicDocumentationReferences(stripFirstMarkdownH1(rewritten), basePath),
        mdxCompileOptions(),
      )
      const path = join(temporaryDir, `page-${index}.mjs`)
      writeFileSync(path, resolveCompiledImports(String(compiled), page.sourcePath, validation.appDir))
      return { path, route: page.route }
    })

    const clientEntry = runtimeEntry('documentation-client-core.js', 'runtime/client.tsx')
    const publicEntry = runtimeEntry('documentation-react.js', 'runtime/public.tsx')
    const serverEntry = runtimeEntry('documentation-server-core.js', 'runtime/server.tsx')
    const browserEntry = join(temporaryDir, 'browser-entry.ts')
    const serverBundleEntry = join(temporaryDir, 'server-entry.ts')
    writeFileSync(browserEntry, generatedBrowserEntry(clientEntry, publicEntry, sitePath, compiledPages))
    writeFileSync(serverBundleEntry, generatedServerEntry(serverEntry, sitePath, compiledPages))

    const reactAliases = runtimeDependencyAliases(validation.appDir)
    const alias = { ...reactAliases, 'deepspace/documentation/react': publicEntry }
    const browserOutDir = join(temporaryDir, 'browser')
    const sharedBuildOptions: BuildOptions = {
      absWorkingDir: temporaryDir,
      bundle: true,
      define: { 'process.env.NODE_ENV': '"production"' },
      jsx: 'automatic',
      target: ['es2022'],
      ...(existsSync(resolve(validation.appDir, 'tsconfig.json'))
        ? { tsconfig: resolve(validation.appDir, 'tsconfig.json') }
        : {}),
      write: false,
    }
    const browser = buildSync({
      ...sharedBuildOptions,
      alias,
      entryPoints: ['browser-entry.ts'],
      chunkNames: 'documentation-page-[hash]',
      entryNames: 'documentation-custom-runtime',
      format: 'esm',
      loader: assetLoaders('dataurl'),
      minify: true,
      outdir: browserOutDir,
      platform: 'browser',
      splitting: true,
    })
    const server = buildSync({
      ...sharedBuildOptions,
      alias: { ...reactAliases, 'deepspace/documentation/react': serverEntry },
      entryPoints: ['server-entry.ts'],
      format: 'cjs',
      loader: { ...assetLoaders('dataurl'), '.css': 'text' },
      logLevel: 'silent',
      minify: false,
      outdir: join(temporaryDir, 'server'),
      platform: 'node',
      target: ['node22'],
    })
    const browserAssets = (browser.outputFiles ?? []).map((output) => ({
      path: relative(browserOutDir, output.path).split(sep).join('/'),
      content: output.text,
    }))
    if (!browserAssets.some((asset) => asset.path === 'documentation-custom-runtime.js')) {
      throw new Error('Executable documentation build did not emit documentation-custom-runtime.js')
    }
    const stylesheets = browserAssets
      .filter((asset) => extname(asset.path) === '.css')
      .map((asset) => documentationPublicPath(basePath, `/assets/${asset.path}`))
    const serverJavaScript = outputWithExtension(server, '.js').text
    const module = { exports: {} as { render?: (route: string, data: DocumentationRuntimeData) => string } }
    const evaluate = new Function('require', 'module', 'exports', serverJavaScript)
    evaluate(createRequire(join(validation.appDir, 'package.json')), module, module.exports)
    if (typeof module.exports.render !== 'function') {
      throw new Error('The generated documentation server renderer did not export render()')
    }
    return {
      browserAssets,
      stylesheets,
      render: (data, route) => module.exports.render?.(route, data) ?? '',
    }
  } catch (error) {
    if (error instanceof DocumentationError) throw error
    throw new DocumentationError(
      `Unable to compile executable documentation: ${errorMessage(error)}`,
      'documentation_runtime_build_failed',
      [{ code: 'runtime_compile', message: errorMessage(error), file: existsSync(sitePath) ? sitePath : undefined }],
    )
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true })
  }
}

function generatedBrowserEntry(
  clientEntry: string,
  publicEntry: string,
  sitePath: string,
  pages: Array<{ path: string; route: string }>,
): string {
  const siteImport = existsSync(sitePath)
    ? `import Site from ${quote(sitePath)}`
    : `import { DefaultDocumentation as Site } from ${quote(publicEntry)}`
  const pageLoaders = pages.map((page) => `${quote(page.route)}: () => import(${quote(page.path)})`).join(',\n')
  return `import { hydrateDocumentation } from ${quote(clientEntry)}
${siteImport}
const loaders = { ${pageLoaders} }
const pages = {}
async function loadPage(route) {
  const loader = loaders[route]
  if (loader && !pages[route]) pages[route] = (await loader()).default
}
const payload = document.getElementById('deepspace-documentation-data')
if (payload?.textContent) await loadPage(JSON.parse(payload.textContent).page.route)
hydrateDocumentation({ Site, pages, loadPage })
`
}

function generatedServerEntry(
  serverEntry: string,
  sitePath: string,
  pages: Array<{ path: string; route: string }>,
): string {
  const imports = pages.map((page, index) => `import Page${index} from ${quote(page.path)}`).join('\n')
  const siteImport = existsSync(sitePath)
    ? `import Site from ${quote(sitePath)}`
    : `import { DefaultDocumentation as Site } from ${quote(serverEntry)}`
  const pageMap = pages.map((page, index) => `${quote(page.route)}: Page${index}`).join(',\n')
  return `import { renderDocumentation } from ${quote(serverEntry)}
${siteImport}
${imports}
const pages = { ${pageMap} }
export function render(route, data) {
  return renderDocumentation({ data, Page: pages[route], Site })
}
`
}

function resolveCompiledImports(code: string, sourcePath: string, appDir: string): string {
  const tree = parseJavaScript(code, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as JavaScriptNode
  const replacements: Array<{ start: number; end: number; value: string }> = []
  const appRequire = createRequire(join(appDir, 'package.json'))
  const resolveAlias = tsconfigAliasResolver(appDir)
  visitJavaScript(tree, (node) => {
    const source = importSource(node)
    if (!source || typeof source.value !== 'string' || source.start === undefined || source.end === undefined) {
      return
    }
    const specifier = source.value
    if (/^(?:data:|https?:|node:)/.test(specifier)) return
    const resolved = specifier.startsWith('.')
      ? resolve(dirname(sourcePath), specifier)
      : specifier === 'deepspace/documentation/react' || specifier === 'react' || specifier.startsWith('react/')
        ? specifier
        : (resolveAlias(specifier) ?? appRequire.resolve(specifier))
    replacements.push({ start: source.start, end: source.end, value: quote(resolved.split(sep).join('/')) })
  })
  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce(
      (output, replacement) =>
        `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`,
      code,
    )
}

/** Map tsconfig `paths` aliases (e.g. `@/*`) to app-rooted absolute paths,
 * like relative imports: the emitted path stays extensionless and esbuild
 * performs extension/tsconfig resolution. First target per pattern only. */
function tsconfigAliasResolver(appDir: string): (specifier: string) => string | undefined {
  let base = appDir
  let aliases: Array<{ prefix: string; exact: boolean; target: string }> = []
  try {
    const raw = readFileSync(join(appDir, 'tsconfig.json'), 'utf8')
    const parsed = JSON.parse(
      raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
    ) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }
    const options = parsed.compilerOptions
    if (options?.paths) {
      base = resolve(appDir, options.baseUrl ?? '.')
      aliases = Object.entries(options.paths)
        .filter(([, targets]) => typeof targets?.[0] === 'string')
        .map(([pattern, targets]) => ({
          exact: !pattern.includes('*'),
          prefix: pattern.replace(/\*$/, ''),
          target: targets[0].replace(/\*$/, ''),
        }))
        .sort((left, right) => right.prefix.length - left.prefix.length)
    }
  } catch {
    // An unreadable tsconfig means no aliases; aliased imports then fail
    // loudly through appRequire.resolve with the original specifier.
  }
  return (specifier) => {
    for (const alias of aliases) {
      if (alias.exact ? specifier === alias.prefix : specifier.startsWith(alias.prefix)) {
        return resolve(base, `${alias.target}${alias.exact ? '' : specifier.slice(alias.prefix.length)}`)
      }
    }
    return undefined
  }
}

function importSource(node: JavaScriptNode): JavaScriptNode | undefined {
  if (
    node.type === 'ImportDeclaration' ||
    node.type === 'ExportAllDeclaration' ||
    node.type === 'ExportNamedDeclaration' ||
    node.type === 'ImportExpression'
  ) return node.source
  return undefined
}

function visitJavaScript(node: JavaScriptNode, visitor: (node: JavaScriptNode) => void): void {
  visitor(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isJavaScriptNode(child)) visitJavaScript(child, visitor)
      }
    } else if (isJavaScriptNode(value)) {
      visitJavaScript(value, visitor)
    }
  }
}

function isJavaScriptNode(value: unknown): value is JavaScriptNode {
  return Boolean(value && typeof value === 'object' && 'type' in value && typeof value.type === 'string')
}

/** Resolve a runtime artifact beside this module, or its source in a repo
 * checkout. A published package has no sources, so a missing artifact fails
 * by name instead of self-compiling. */
export function runtimeEntry(builtName: string, sourceRelativePath: string): string {
  const built = fileURLToPath(new URL(`./${builtName}`, import.meta.url))
  if (existsSync(built)) return built
  const source = fileURLToPath(new URL(`./${sourceRelativePath}`, import.meta.url))
  if (!existsSync(source)) {
    throw new Error(`${builtName} is missing from this deepspace installation; reinstall the package`)
  }
  return source
}

function runtimeDependencyAliases(appDir: string): Record<string, string> {
  const require = createRequire(join(appDir, 'package.json'))
  return Object.fromEntries(
    ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'react-dom/server']
      .map((specifier) => [specifier, require.resolve(specifier)]),
  )
}

function outputWithExtension(result: BuildResult, extension: string): OutputFile {
  const output = optionalOutputWithExtension(result, extension)
  if (!output) throw new Error(`Executable documentation build did not emit a ${extension} file`)
  return output
}

function optionalOutputWithExtension(result: BuildResult, extension: string): OutputFile | undefined {
  return result.outputFiles?.find((output) => extname(output.path) === extension)
}

function assetLoaders(imageLoader: 'dataurl'): Record<string, 'css' | 'dataurl'> {
  return {
    '.avif': imageLoader,
    '.css': 'css',
    '.gif': imageLoader,
    '.jpeg': imageLoader,
    '.jpg': imageLoader,
    '.png': imageLoader,
    '.svg': imageLoader,
    '.webp': imageLoader,
    '.woff': imageLoader,
    '.woff2': imageLoader,
  }
}

function quote(value: string): string {
  return JSON.stringify(value)
}
