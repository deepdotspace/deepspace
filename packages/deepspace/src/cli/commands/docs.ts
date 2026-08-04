import { defineCommand } from 'citty'
import { existsSync, mkdirSync, statSync, watch, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, relative, resolve } from 'node:path'
import {
  buildDocs,
  DEFAULT_DOCS_CONTEXTUAL_ACTIONS,
  validateDocs,
  DocsError,
  type DocsBuildResult,
} from '../../docs'
import { defineDeepspaceCommand, Refusal } from '../lib/command'
import { serveStatic, shouldIgnoreWatchPath } from './docs/dev-server'
import { installDocsWorkerSupport } from './docs/install'

export { docsMimeType } from './docs/dev-server'
export { installDocsWorkerSupport } from './docs/install'

const starterConfig = {
  $schema: 'https://deep.space/docs.schema.json',
  name: 'My App',
  description: 'Documentation for My App.',
  source: 'docs',
  output: 'dist/_docs',
  theme: { accent: '#6d5efc', defaultMode: 'system' },
  navigation: [{ group: 'Get started', pages: ['index'] }],
  assistant: { access: 'disabled' },
  mcp: { access: 'public' },
  contextual: {
    actions: [...DEFAULT_DOCS_CONTEXTUAL_ACTIONS],
  },
}

const starterPage = `---
title: Welcome
description: Start building with this app.
---

# Welcome

This documentation is built and deployed from the same DeepSpace repository as
your app.

<Note title="Agent native">
Run \`deepspace docs validate --json\` before deployment to check navigation,
links, content safety, and generated API references.
</Note>
`

const directoryArgument = {
  type: 'positional',
  description: 'App directory (default: current directory)',
  required: false,
} as const

const init = defineDeepspaceCommand({
  meta: { name: 'init', description: 'Initialize public documentation in an app repository' },
  args: { dir: directoryArgument },
  async run({ args }) {
    const appDir = resolveDirectory(args.dir)
    if (!existsSync(appDir) || !statSync(appDir).isDirectory()) {
      throw new Refusal(`Directory not found: ${appDir}`, 'docs_app_dir_missing')
    }
    const configPath = join(appDir, 'docs.json')
    const pagePath = join(appDir, 'docs', 'index.mdx')
    const created: string[] = []
    const updated = installDocsWorkerSupport(appDir)
    const skipped: string[] = []
    if (existsSync(configPath)) skipped.push(configPath)
    else {
      writeFileSync(configPath, `${JSON.stringify(starterConfig, null, 2)}\n`)
      created.push(configPath)
    }
    if (existsSync(pagePath)) skipped.push(pagePath)
    else {
      mkdirSync(join(appDir, 'docs'), { recursive: true })
      writeFileSync(pagePath, starterPage)
      created.push(pagePath)
    }
    if (!args.json) {
      console.log(
        created.length
          ? `Created ${created.length} documentation file(s).`
          : 'Documentation is already initialized.',
      )
      for (const path of created) console.log(`  + ${relative(appDir, path)}`)
      for (const path of updated) console.log(`  ~ ${relative(appDir, path)} (docs runtime wired)`)
      for (const path of skipped) console.log(`  = ${relative(appDir, path)} (kept)`)
    }
    return {
      data: {
        appDir,
        created: created.map((path) => relative(appDir, path)),
        updated: updated.map((path) => relative(appDir, path)),
        skipped: skipped.map((path) => relative(appDir, path)),
      },
    }
  },
})
const validate = defineDeepspaceCommand({
  meta: { name: 'validate', description: 'Validate docs config, content, links, and API inputs' },
  args: { dir: directoryArgument },
  async run({ args }) {
    const appDir = resolveDirectory(args.dir)
    const result = runDocs(() => validateDocs(appDir))
    if (!args.json) {
      console.log(
        `Valid documentation: ${result.graph.pages.length} page(s), ` +
          `${result.graph.sourceHash.slice(0, 12)} source hash`,
      )
      for (const warning of result.warnings)
        console.warn(`Warning [${warning.code}]: ${warning.message}`)
    }
    return {
      data: {
        appDir: result.appDir,
        configPath: result.configPath,
        sourceDir: result.sourceDir,
        outputDir: result.outputDir,
        pageCount: result.graph.pages.length,
        routes: result.graph.pages.map((page) => page.route),
        sourceHash: result.graph.sourceHash,
        warnings: result.warnings,
      },
    }
  },
})

const build = defineDeepspaceCommand({
  meta: { name: 'build', description: 'Compile public documentation into static assets' },
  args: {
    dir: directoryArgument,
    'out-dir': { type: 'string', description: 'Override the generated output directory' },
  },
  async run({ args }) {
    const appDir = resolveDirectory(args.dir)
    const outputDir =
      typeof args['out-dir'] === 'string' ? resolve(appDir, args['out-dir']) : undefined
    const result = runDocs(() => buildDocs({ appDir, ...(outputDir ? { outputDir } : {}) }))
    if (!args.json) {
      console.log(
        `Built ${result.manifest.pageCount} documentation page(s) and ` +
          `${result.files.length} artifact(s) in ${relative(appDir, result.outputDir)}`,
      )
      console.log(`Output hash: ${result.manifest.outputHash}`)
    }
    return { data: buildData(result) }
  },
})

const dev = defineCommand({
  meta: { name: 'dev', description: 'Build, serve, and watch public documentation' },
  args: {
    dir: directoryArgument,
    port: { type: 'string', description: 'Local port', default: '4321' },
    json: { type: 'boolean', description: 'Emit an NDJSON ready/rebuild stream', default: false },
  },
  async run({ args }) {
    const appDir = resolveDirectory(args.dir)
    const port = Number(args.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Refusal(`Invalid docs dev port: ${args.port}`, 'docs_port_invalid')
    }
    let result = runDocs(() => buildDocs({ appDir }))
    const emit = (event: Record<string, unknown>): void => {
      if (args.json) console.log(JSON.stringify(event))
      else if (event.type === 'ready') console.log(`DeepSpace Docs ready at ${event.url}`)
      else if (event.type === 'rebuilt') console.log(`Rebuilt docs (${event.outputHash})`)
      else console.error(`Docs build failed: ${event.error}`)
    }
    const server = createServer((request, response) => {
      serveStatic(result.outputDir, request.url ?? '/', response)
    })
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolveListen)
    })
    emit({
      ok: true,
      type: 'ready',
      url: `http://127.0.0.1:${port}`,
      ...buildData(result),
    })

    let timer: NodeJS.Timeout | undefined
    const watcher = watch(appDir, { recursive: true }, (_event, filename) => {
      if (!filename || shouldIgnoreWatchPath(filename)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        try {
          result = buildDocs({ appDir })
          emit({ ok: true, type: 'rebuilt', ...buildData(result) })
        } catch (error) {
          emit({ ok: false, type: 'error', error: errorMessage(error), ...docsErrorData(error) })
        }
      }, 120)
    })
    await new Promise<void>((resolveStop) => {
      const stop = (): void => {
        watcher.close()
        server.close(() => resolveStop())
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
  },
})


function buildData(result: DocsBuildResult): Record<string, unknown> {
  return {
    appDir: result.appDir,
    outputDir: result.outputDir,
    pageCount: result.manifest.pageCount,
    artifactCount: result.files.length,
    routes: result.manifest.routes,
    sourceHash: result.manifest.sourceHash,
    outputHash: result.manifest.outputHash,
    assistant: result.manifest.assistant,
    mcp: result.manifest.mcp,
  }
}

function runDocs<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof DocsError) {
      throw new Refusal(error.message, error.code, { extra: docsErrorData(error) })
    }
    throw error
  }
}

function docsErrorData(error: unknown): Record<string, unknown> {
  return error instanceof DocsError ? { diagnostics: error.diagnostics } : {}
}

function resolveDirectory(value: unknown): string {
  return resolve(typeof value === 'string' && value.trim() ? value : '.')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default defineCommand({
  meta: { name: 'docs', description: 'Build and operate public documentation' },
  subCommands: { init, validate, build, dev },
})
