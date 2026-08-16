/**
 * `deepspaceBuild()` — the one Vite plugin an app's build config needs.
 *
 * It carries the build-time wiring that is identical in every DeepSpace app
 * and belongs to the SDK's contract rather than to app code:
 *
 *   1. the app id `define` (see ./app-id) — so the browser is keyed to the
 *      environment THIS build targets, never a literal frozen at scaffold time;
 *   2. removing the preview `.dev.vars` the Cloudflare plugin drops beside the
 *      built worker — DeepSpace has one local runtime, so that second plaintext
 *      copy is not kept;
 *   3. the client `dedupe` hint — two copies of React (or better-auth) break
 *      the SDK's hooks, and which packages must be single-instance is the SDK's
 *      knowledge, not the app's.
 *
 * Housing these here means a future fix to any of them ships in an SDK version
 * bump, with no edit to — and no migration of — a single app.
 *
 * The return is a structural Vite plugin: typing it against `vite` would make
 * the SDK carry a Vite dependency it otherwise does not need, and Vite's
 * plugin hooks are optional and method-shaped, so a compatible object is
 * assignable to `PluginOption` where an app composes it.
 */

import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { appIdDefine } from './app-id'
import type { ResolveAppIdOptions } from './app-id'

/**
 * Packages that must resolve to a single instance in the client graph. Two
 * Reacts throw "Cannot read properties of null (reading 'useState')"; two
 * better-auth clients split the session. The SDK owns this list because it is
 * the SDK's hooks and auth client that break when it is wrong.
 */
export const CLIENT_DEDUPE: readonly string[] = ['react', 'react-dom', 'better-auth']

/** The subset of Vite's `Plugin` this helper implements — declared locally so
 *  `deepspace/build` needs no `vite` dependency. Assignable to `PluginOption`. */
interface VitePluginLike {
  name: string
  enforce?: 'pre' | 'post'
  config(): { define: Record<string, string>; resolve: { dedupe: string[] } }
  closeBundle(): void
}

export type DeepspaceBuildOptions = ResolveAppIdOptions

export function deepspaceBuild(options: DeepspaceBuildOptions): VitePluginLike {
  const distDir = resolve(options.appDir, 'dist')
  return {
    name: 'deepspace-build',
    enforce: 'post',
    config() {
      return {
        define: appIdDefine(options),
        resolve: { dedupe: [...CLIENT_DEDUPE] },
      }
    },
    closeBundle() {
      // Cloudflare emits a preview-only `.dev.vars` beside each built worker.
      if (!existsSync(distDir)) return
      for (const entry of readdirSync(distDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const secretPath = join(distDir, entry.name, '.dev.vars')
        if (existsSync(secretPath)) unlinkSync(secretPath)
      }
    },
  }
}
