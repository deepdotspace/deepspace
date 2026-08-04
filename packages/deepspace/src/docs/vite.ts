import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { relative, resolve, sep } from 'node:path'
import { buildDocs } from './build'
import { docsDevHeaders, isWithinPath } from './dev-http'
import { DOCS_CONFIG_FILE, type DocsBuildResult } from './types'

interface DocsViteServer {
  middlewares: {
    use(
      handler: (request: IncomingMessage, response: ServerResponse, next: () => void) => void,
    ): void
  }
  watcher: {
    add(paths: string[]): void
    on(event: 'all', handler: (event: string, path: string) => void): void
  }
  config: {
    logger: {
      info(message: string): void
      error(message: string): void
    }
  }
}

/**
 * Vite development bridge for the app Worker's ASSETS binding.
 *
 * Deployed docs are bundled after the app build. In development the Worker is
 * already live, so this plugin compiles the same graph into an ignored cache
 * and serves only the reserved `/_docs/*` asset namespace through Vite.
 */
export function deepSpaceDocs(): {
  name: string
  apply: 'serve'
  config(config: { root?: string }): void
  configResolved(config: { root: string }): void
  configureServer(server: DocsViteServer): void
} {
  let appDir = process.cwd()
  let result: DocsBuildResult | null = null

  const rebuild = (): DocsBuildResult | null => {
    const outputDir = resolve(appDir, 'public', '_docs')
    if (!existsSync(resolve(appDir, DOCS_CONFIG_FILE))) {
      rmSync(outputDir, { recursive: true, force: true })
      result = null
      return null
    }
    result = buildDocs({
      appDir,
      outputDir,
    })
    return result
  }

  return {
    name: 'deepspace-docs',
    apply: 'serve',
    config(config) {
      appDir = resolve(config.root ?? process.cwd())
      rebuild()
    },
    configResolved(config) {
      const resolvedRoot = resolve(config.root)
      if (resolvedRoot === appDir) return
      appDir = resolvedRoot
      rebuild()
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!result || !serveDocsDevAsset(result.outputDir, request, response)) next()
      })
      if (!result) return

      const configPath = resolve(appDir, DOCS_CONFIG_FILE)
      server.watcher.add([configPath, resolve(appDir, 'docs.tsx'), result.sourceDir])
      let timer: ReturnType<typeof setTimeout> | undefined
      server.watcher.on('all', (_event, path) => {
        const changed = resolve(path)
        if (!shouldRebuildDocs(appDir, configPath, result?.sourceDir ?? '', changed)) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          try {
            const next = rebuild()
            if (next) {
              server.config.logger.info(
                `[deepspace docs] rebuilt ${next.manifest.pageCount} page(s)`,
              )
            }
          } catch (error) {
            server.config.logger.error(
              `[deepspace docs] rebuild failed: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }, 120)
      })
    },
  }
}

function shouldRebuildDocs(
  appDir: string,
  configPath: string,
  sourceDir: string,
  changed: string,
): boolean {
  if (
    changed === configPath ||
    changed === resolve(appDir, 'docs.tsx') ||
    isWithinPath(sourceDir, changed)
  ) {
    return true
  }
  if (!isWithinPath(appDir, changed) || !/\.(?:css|js|jsx|ts|tsx)$/i.test(changed)) return false
  const relativePath = relative(appDir, changed).split(sep).join('/')
  return !/^(?:\.deepspace|\.git|\.wrangler|dist|node_modules|public\/_docs)(?:\/|$)/.test(
    relativePath,
  )
}

export function serveDocsDevAsset(
  outputDir: string,
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const requestUrl = request.url ?? '/'
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://docs.local').pathname)
  } catch {
    return false
  }
  if (!pathname.startsWith('/_docs/')) return false
  const relativePath = pathname.slice('/_docs/'.length)
  const selected = resolve(outputDir, relativePath)
  if (!isWithinPath(outputDir, selected) || !existsSync(selected) || !statSync(selected).isFile()) {
    response.writeHead(404, docsDevHeaders(selected))
    response.end('Not found')
    return true
  }
  response.writeHead(200, docsDevHeaders(selected))
  response.end(readFileSync(selected))
  return true
}
