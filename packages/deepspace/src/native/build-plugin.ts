/**
 * Build-time module substitution for the `deepspace/native` bundle.
 *
 * Used by tsup.config.ts and the native bundle test; not part of any public
 * entry. For every import that resolves inside `src/`, the plugin prefers a
 * sibling `<name>.native.ts(x)` when one exists, the same rule Metro applies
 * to React Native sources. Browser bundles never load this plugin, so their
 * module graph is unchanged.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'esbuild'

const SKIP = Symbol('deepspace-native-resolution')

export function nativeModuleCandidate(resolvedPath: string): string | null {
  const match = /^(.*)\.(tsx?)$/.exec(resolvedPath)
  if (!match || match[1].endsWith('.native')) return null
  for (const extension of ['ts', 'tsx']) {
    const candidate = `${match[1]}.native.${extension}`
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function preferNativeModules(sourceRoot: string): Plugin {
  const root = resolve(sourceRoot)
  return {
    name: 'deepspace-prefer-native-modules',
    setup(build) {
      build.onResolve({ filter: /^(\.|@\/)/ }, async (args) => {
        if (args.pluginData === SKIP) return undefined
        const result = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: SKIP,
        })
        if (result.errors.length > 0) return { errors: result.errors }
        if (result.external || !result.path.startsWith(root)) return result
        return { path: nativeModuleCandidate(result.path) ?? result.path }
      })
    },
  }
}
