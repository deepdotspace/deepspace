import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { runtimeEntry } from './custom-runtime'
import type { DocumentationRuntimeData } from './types'

interface DefaultRendererModule {
  renderDefaultDocumentation(data: DocumentationRuntimeData): string
}

let cachedRenderer: DefaultRendererModule | undefined

/**
 * Load default React SSR behind a runtime boundary. The native documentation compiler
 * and the DeepSpace CLI can be imported without evaluating React or
 * react-dom/server.
 */
export function renderDefaultDocumentation(data: DocumentationRuntimeData): string {
  cachedRenderer ??= loadDefaultRenderer()
  return cachedRenderer.renderDefaultDocumentation(data)
}

function loadDefaultRenderer(): DefaultRendererModule {
  const entry = runtimeEntry('documentation-default-renderer.cjs', 'runtime/default-renderer.tsx')
  if (entry.endsWith('.cjs')) {
    return createRequire(import.meta.url)(entry) as DefaultRendererModule
  }

  const result = buildSync({
    entryPoints: [entry],
    bundle: true,
    write: false,
    minify: false,
    platform: 'node',
    format: 'cjs',
    target: ['node22'],
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const source = result.outputFiles?.[0]?.text
  if (!source) throw new Error('Default documentation renderer did not emit JavaScript')

  const module = { exports: {} as DefaultRendererModule }
  const evaluate = new Function('require', 'module', 'exports', source)
  evaluate(createRequire(import.meta.url), module, module.exports)
  return module.exports
}
