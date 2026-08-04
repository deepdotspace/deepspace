import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Refusal } from '../../lib/command'

/** Idempotently migrate a generated pre-docs app onto SDK-owned docs routes. */
export function installDocsWorkerSupport(appDir: string): string[] {
  const workerPath = join(appDir, 'worker.ts')
  const wranglerPath = join(appDir, 'wrangler.toml')
  const vitePath = join(appDir, 'vite.config.ts')
  const gitignorePath = join(appDir, '.gitignore')
  if (!existsSync(workerPath) || !existsSync(wranglerPath) || !existsSync(vitePath)) {
    throw new Refusal(
      'docs init requires worker.ts, wrangler.toml, and vite.config.ts in a DeepSpace app',
      'docs_worker_missing',
    )
  }

  const originalWorker = readFileSync(workerPath, 'utf8')
  const originalWrangler = readFileSync(wranglerPath, 'utf8')
  const originalVite = readFileSync(vitePath, 'utf8')
  const originalGitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : ''
  let worker = originalWorker
  let wrangler = originalWrangler
  let vite = originalVite
  let gitignore = originalGitignore

  const sdkSymbols = [
    'DocsAssistantLimiter',
    'docsAssistantLimiterManifestEntry',
    'registerDeepSpaceDocs',
  ].filter((symbol) => !new RegExp(`\\b${symbol}\\b`).test(worker))
  if (sdkSymbols.length > 0) {
    worker = `import { ${sdkSymbols.join(', ')} } from 'deepspace/worker'\n${worker}`
  }

  const legacyLimiterEntry = /\n\s*\{\s*binding:\s*['"]DOCS_ASSISTANT_LIMITER['"],\s*className:\s*['"]AppDocsAssistantLimiter['"],\s*sqlite:\s*true\s*\},?/
  if (legacyLimiterEntry.test(worker)) {
    worker = worker.replace(
      legacyLimiterEntry,
      "\n  docsAssistantLimiterManifestEntry('AppDocsAssistantLimiter'),",
    )
  } else if (!worker.includes("docsAssistantLimiterManifestEntry('AppDocsAssistantLimiter')")) {
    worker = replaceRequired(
      worker,
      /\n\] as const satisfies DOManifest/,
      "\n  docsAssistantLimiterManifestEntry('AppDocsAssistantLimiter'),\n] as const satisfies DOManifest",
      'the __DO_MANIFEST__ closing marker',
    )
  }
  if (!worker.includes('class AppDocsAssistantLimiter')) {
    worker = replaceRequired(
      worker,
      /\nexport interface Env /,
      '\nexport class AppDocsAssistantLimiter extends DocsAssistantLimiter {}\n\nexport interface Env ',
      'the Env interface',
    )
  }
  for (const legacyRegistration of [
    'registerDocsAssistantRoutes\\(app, resolveAuth\\)',
    'registerDocsMcpRoutes\\(app\\)',
    'registerDocsStaticRoutes\\(app\\)',
  ]) {
    worker = worker.replace(new RegExp(`^\\s*${legacyRegistration}\\s*$`, 'gm'), '')
  }
  worker = removeNamedImports(worker, 'deepspace/worker', [
    'registerDocsAssistantRoutes',
    'registerDocsMcpRoutes',
    'registerDocsStaticRoutes',
  ])
  if (!worker.includes('registerDeepSpaceDocs(app, { resolveAuth })')) {
    worker = insertBeforeRouteRegistration(worker, 'registerDeepSpaceDocs(app, { resolveAuth })\n')
  }

  if (!wrangler.includes('name = "DOCS_ASSISTANT_LIMITER"')) {
    const bindingPattern = /(\[durable_objects\][\s\S]*?bindings\s*=\s*\[[\s\S]*?)(\n\])/m
    if (!bindingPattern.test(wrangler)) {
      throw new Refusal(
        'Could not safely add the docs limiter binding to wrangler.toml',
        'docs_worker_migration_unsupported',
      )
    }
    wrangler = wrangler.replace(
      bindingPattern,
      '$1\n  { name = "DOCS_ASSISTANT_LIMITER", class_name = "AppDocsAssistantLimiter" },$2',
    )
    const tag = nextDocsMigrationTag(wrangler)
    wrangler = `${wrangler.trimEnd()}\n\n[[migrations]]\ntag = "${tag}"\nnew_sqlite_classes = ["AppDocsAssistantLimiter"]\n`
  }
  if (!/\bdeepSpaceDocs\b/.test(vite)) {
    vite = `import { deepSpaceDocs } from 'deepspace/docs'\n${vite}`
  }
  if (!vite.includes('deepSpaceDocs()')) {
    vite = replaceRequired(
      vite,
      /plugins\s*:\s*\[/,
      'plugins: [\n    deepSpaceDocs(),',
      'the Vite plugins array',
    )
  }
  if (!new Set(gitignore.split(/\r?\n/).map((line) => line.trim())).has('public/_docs')) {
    const separator = !gitignore || gitignore.endsWith('\n') ? '' : '\n'
    gitignore = `${gitignore}${separator}public/_docs\n`
  }

  // Perform no writes until every expected structure has been proven safe.
  const updated: string[] = []
  if (worker !== originalWorker) {
    writeFileSync(workerPath, worker)
    updated.push(workerPath)
  }
  if (wrangler !== originalWrangler) {
    writeFileSync(wranglerPath, wrangler)
    updated.push(wranglerPath)
  }
  if (vite !== originalVite) {
    writeFileSync(vitePath, vite)
    updated.push(vitePath)
  }
  if (gitignore !== originalGitignore) {
    writeFileSync(gitignorePath, gitignore)
    updated.push(gitignorePath)
  }
  return updated
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceRequired(
  source: string,
  pattern: RegExp,
  replacement: string,
  marker: string,
): string {
  if (!pattern.test(source)) {
    throw new Refusal(
      `Could not safely wire documentation support: missing ${marker}`,
      'docs_worker_migration_unsupported',
    )
  }
  return source.replace(pattern, replacement)
}

function insertBeforeRouteRegistration(worker: string, registration: string): string {
  for (const marker of ['registerPlatformProxyRoutes(app)', 'registerStaticRoutes(app)']) {
    if (worker.includes(marker)) return worker.replace(marker, `${registration}${marker}`)
  }
  throw new Refusal(
    'Could not safely wire documentation support: no final route registration marker found',
    'docs_worker_migration_unsupported',
  )
}

function removeNamedImports(source: string, moduleName: string, symbols: string[]): string {
  const removable = new Set(symbols)
  const pattern = new RegExp(
    `import\\s*\\{([^}]+)\\}\\s*from\\s*(['"])${escapeRegExp(moduleName)}\\2\\s*;?`,
    'g',
  )
  return source.replace(pattern, (_statement, rawNames: string, quote: string) => {
    const names = rawNames
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .filter((name) => !removable.has(name.split(/\s+as\s+/)[0] ?? name))
    return names.length > 0 ? `import { ${names.join(', ')} } from ${quote}${moduleName}${quote}` : ''
  })
}

function nextDocsMigrationTag(wrangler: string): string {
  const existing = new Set(
    [...wrangler.matchAll(/^tag\s*=\s*"([^"]+)"/gm)].map((match) => match[1]),
  )
  let sequence = 1
  while (existing.has(`docs-v${sequence}`)) sequence++
  return `docs-v${sequence}`
}
