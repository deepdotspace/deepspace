import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { buildDocumentation } from './build'
import { DOCUMENTATION_CONFIG_FILE, type DocumentationBuildResult } from './types'

const IGNORED_DOCUMENTATION_WATCH_PATH =
  /^(?:\.deepspace|\.git|\.wrangler|dist|node_modules|public\/_documentation(?:-root)?|src\/router\.ts)(?:\/|$)/

interface DocumentationViteServer {
  restart(): Promise<void>
  watcher: {
    add(paths: string[]): void
    on(event: 'all', handler: (event: string, path: string) => void): void
    on(event: 'ready', handler: () => void): void
  }
  config: {
    logger: {
      info(message: string): void
      error(message: string): void
    }
  }
}

/**
 * Vite bridge for the app Worker's ASSETS binding.
 *
 * Both development and production write Vite's reserved public namespace so
 * the Cloudflare ASSETS binding has one identical source in both environments.
 * Documentation's feature metadata sets `run_worker_first = true`, leaving the
 * app Worker as the single router while binding reads bypass it as assets.
 */
export function deepSpaceDocumentation(): {
  name: string
  config(
    config: { root?: string },
    _environment: { command: 'build' | 'serve' },
  ): {
    server: { watch: { ignored: string[] } }
  }
  configResolved(config: { root: string }): void
  configureServer(server: DocumentationViteServer): void
} {
  let appDir = process.cwd()
  let outputDir = resolve(appDir, '.deepspace', 'documentation')
  let result: DocumentationBuildResult | null = null

  const rebuild = (): DocumentationBuildResult | null => {
    if (!existsSync(resolve(appDir, DOCUMENTATION_CONFIG_FILE))) {
      rmSync(outputDir, { recursive: true, force: true })
      rmSync(`${outputDir}-root`, { recursive: true, force: true })
      result = null
      return null
    }
    // Deploy supplies the public origin so this one compile is the release
    // artifact; development leaves it unset and keeps relative URLs.
    const baseUrl = process.env.DEEPSPACE_DOCUMENTATION_BASE_URL
    result = buildDocumentation({
      appDir,
      outputDir,
      ...(baseUrl ? { baseUrl } : {}),
    })
    if (result.manifest.domains.length) {
      buildDocumentation({
        appDir,
        outputDir: `${outputDir}-root`,
        basePath: '',
        baseUrl: `https://${result.manifest.domains[0]}`,
      })
    } else rmSync(`${outputDir}-root`, { recursive: true, force: true })
    return result
  }

  return {
    name: 'deepspace-documentation',
    config(config, environment) {
      appDir = resolve(config.root ?? process.cwd())
      outputDir = resolve(appDir, 'public', '_documentation')
      if (environment.command === 'serve') {
        rmSync(resolve(appDir, '.deepspace', 'documentation'), { recursive: true, force: true })
        rmSync(resolve(appDir, '.deepspace', 'documentation-root'), {
          recursive: true,
          force: true,
        })
      }
      try {
        rebuild()
      } catch (error) {
        // Vite reports only the message; keep the per-file diagnostics.
        throw new Error(documentationBuildErrorMessage(error), { cause: error })
      }
      return {
        server: {
          watch: {
            ignored: ['**/.deepspace/documentation*/**', '**/public/_documentation*/**'],
          },
        },
      }
    },
    configResolved(config) {
      const resolvedRoot = resolve(config.root)
      const rootChanged = !pathsReferToSameDirectory(appDir, resolvedRoot)
      appDir = resolvedRoot
      outputDir = resolve(appDir, 'public', '_documentation')
      if (rootChanged) rebuild()
    },
    configureServer(server) {
      if (!result) return

      const configPath = resolve(appDir, DOCUMENTATION_CONFIG_FILE)
      const customRuntimePath = resolve(appDir, 'documentation.tsx')
      const watchedPaths = [configPath, customRuntimePath, result.sourceDir]
      const initialPaths = currentDocumentationPaths(appDir)
      server.watcher.add(watchedPaths)
      const initialReplayTimeout = setTimeout(() => initialPaths.clear(), 10_000)
      initialReplayTimeout.unref()
      server.watcher.on('ready', () => {
        clearTimeout(initialReplayTimeout)
        initialPaths.clear()
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      server.watcher.on('all', (event, path) => {
        const changed = canonicalPath(path)
        if ((event === 'add' || event === 'addDir') && initialPaths.delete(changed)) return
        if (!shouldRebuildDocumentation(appDir, configPath, result?.sourceDir ?? '', changed))
          return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          try {
            const previousDomains = result?.manifest.domains ?? []
            const next = rebuild()
            if (next) {
              server.config.logger.info(
                `[deepspace] rebuilt ${next.manifest.pageCount} documentation page(s)`,
              )
              if (
                changed === canonicalPath(configPath) &&
                !sameDomains(previousDomains, next.manifest.domains)
              ) {
                void server.restart().catch((error) => {
                  server.config.logger.error(
                    `[deepspace] development Worker restart failed: ${error instanceof Error ? error.message : String(error)}`,
                  )
                })
              }
            }
          } catch (error) {
            server.config.logger.error(
              `[deepspace] documentation rebuild failed: ${documentationBuildErrorMessage(error)}`,
            )
          }
        }, 120)
      })
    },
  }
}

export function documentationBuildErrorMessage(error: unknown): string {
  const diagnostics =
    error && typeof error === 'object' && 'diagnostics' in error
      ? (error as { diagnostics?: Array<{ file?: string; line?: number; message: string }> })
          .diagnostics
      : undefined
  if (!diagnostics?.length) return error instanceof Error ? error.message : String(error)
  return diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.file ?? 'documentation.json'}${diagnostic.line ? `:${diagnostic.line}` : ''}: ${diagnostic.message}`,
    )
    .join('\n')
}

function sameDomains(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const expected = new Set(right)
  return left.every((domain) => expected.has(domain))
}

function currentDocumentationPaths(appDir: string): Set<string> {
  const paths = new Set<string>()
  const directories = [appDir]
  for (const directory of directories) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      const relativePath = relative(appDir, path).split(sep).join('/')
      if (IGNORED_DOCUMENTATION_WATCH_PATH.test(relativePath)) continue
      paths.add(canonicalPath(path))
      if (entry.isDirectory()) directories.push(path)
    }
  }
  return paths
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function pathsReferToSameDirectory(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right)
}

function isWithinPath(root: string, candidate: string): boolean {
  if (!root) return false
  const path = relative(resolve(root), resolve(candidate))
  return path !== '..' && !path.startsWith(`..${sep}`)
}

function shouldRebuildDocumentation(
  appDir: string,
  configPath: string,
  sourceDir: string,
  changed: string,
): boolean {
  appDir = canonicalPath(appDir)
  configPath = canonicalPath(configPath)
  sourceDir = canonicalPath(sourceDir)
  if (
    changed === configPath ||
    changed === resolve(appDir, 'documentation.tsx') ||
    isWithinPath(sourceDir, changed)
  ) {
    return true
  }
  if (!isWithinPath(appDir, changed) || !/\.(?:css|js|jsx|ts|tsx)$/i.test(changed)) return false
  const relativePath = relative(appDir, changed).split(sep).join('/')
  return !IGNORED_DOCUMENTATION_WATCH_PATH.test(relativePath)
}
