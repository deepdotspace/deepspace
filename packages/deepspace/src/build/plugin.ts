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
 *      copy is not kept (`removeBuildDevVars` below; `deepspace deploy` calls
 *      the same function on the artifact it ships);
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

import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { appIdDefine } from './app-id'
import type { ResolveAppIdOptions } from './app-id'

/**
 * Delete Cloudflare's preview-only `.dev.vars` copy from ONE built worker dir.
 * Returns whether a file was removed; throws rather than following a symlink
 * or unlinking a directory, so a booby-trapped build output cannot make this
 * delete something else.
 *
 * TWO call sites, deliberately, and this is the single implementation they
 * share (they used to have one each, with only the CLI's carrying the symlink
 * guard):
 *
 *   1. `closeBundle` below — every `vite build` of an app that uses
 *      `deepspaceBuild()`, including plain `npm run build` in CI, so a generic
 *      archive step cannot pick the plaintext file up.
 *   2. `cli/commands/deploy/build.ts` — the AUTHORITATIVE one: it runs against
 *      the exact worker dir the deploy is about to read, covers apps that do
 *      not use this plugin, and fails the deploy (`build_output_unsafe`) when
 *      the path is unsafe.
 *
 * Neither subsumes the other — they have different lifetimes (any build vs.
 * the artifact that ships). See `docs/migrations/build-preview-secrets.md`.
 */
export function removeBuildDevVars(workerDir: string): boolean {
  const path = join(workerDir, '.dev.vars')
  if (!existsSync(path)) return false
  // lstat, not stat: a symlink reports as a link, not as its target's file.
  if (!lstatSync(path).isFile()) {
    throw new Error(`Refusing unsafe build secret path: ${path}`)
  }
  unlinkSync(path)
  return true
}

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
      // Sweep every worker dir before reporting an unsafe one: an early throw
      // would leave the plaintext copies after it in place (fail-open).
      if (!existsSync(distDir)) return
      const unsafe: string[] = []
      for (const entry of readdirSync(distDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        try {
          removeBuildDevVars(join(distDir, entry.name))
        } catch (err) {
          unsafe.push(err instanceof Error ? err.message : String(err))
        }
      }
      if (unsafe.length > 0) throw new Error(unsafe.join('\n'))
    },
  }
}
