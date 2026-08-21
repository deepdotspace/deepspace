/**
 * `deepspace/build` — build-time helpers an app's Vite config imports.
 *
 * Node-only. Nothing here may be reached from client or worker code; it runs
 * while `vite build` / `vite dev` is assembling the bundle, never inside it.
 *
 * The one job today is resolving the app's immutable id for the browser.
 * `wrangler.toml` is the single source of truth for app identity — the worker
 * reads `DEEPSPACE_APP_ID` off `env`, and every durable thing (data scope
 * `app:{appId}`, secrets, billing) keys to it. The browser has no `env`, so
 * the build stamps the same value in as `__DEEPSPACE_APP_ID__`, read from the
 * config THIS build is running against. A literal baked into the client once,
 * at scaffold time, is what let `deepspace deploy --env staging` ship a worker
 * writing staging's rooms beside a browser reading production's, with nothing
 * reporting the split.
 *
 * Living in the SDK rather than in a file copied into every app means one
 * definition, no per-app duplicate, and `smol-toml` stays the SDK's dependency
 * instead of every app's.
 */

import { resolve } from 'node:path'

/** `app_` + 26-char Crockford ULID. */
// Single source: the shared registry client owns the id shape.
import { APP_ID_RE } from '../server/utils/registry-client'
// Single source: `cli/lib/wrangler-env` is the SDK's only wrangler.toml reader,
// so the build sees the same parse, the same failure shape, and the same
// whole-file guards the CLI does. Both are Node-only. Imported as that one
// module, never through the CLI barrel — nothing else of the CLI belongs in an
// app's build graph.
import { readAppIdVar, readWranglerConfigFile } from '../cli/lib/wrangler-env'

/**
 * The build's environment, typed structurally. This module is imported from an
 * app's `vite.config.ts`, which sits outside the app's tsconfig `include` and
 * runs where the app carries no `@types/node`, so nothing here leans on the
 * ambient `NodeJS` namespace.
 */
export type BuildEnv = Record<string, string | undefined>

export interface ResolveAppIdOptions {
  /**
   * The app root — the directory holding `wrangler.toml`. The caller passes
   * its own location (`fileURLToPath(new URL('.', import.meta.url))` from
   * `vite.config.ts`), so the config is found by an authoritative anchor
   * rather than a guessed `process.cwd()`.
   */
  appDir: string
  /** Defaults to `process.env`; injectable for tests. */
  env?: BuildEnv
}

/**
 * Resolve the app id the browser bundle must carry.
 *
 * Mirrors the Cloudflare Vite plugin so dev, a bare `vite build`, and
 * `deepspace deploy --env <name>` all agree:
 *
 *   config  ← CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH, else <appDir>/wrangler.toml
 *   section ← [env.<CLOUDFLARE_ENV>.vars] when that is set, else [vars]
 *
 * Env blocks do NOT inherit `[vars]` — each environment is its own app — so a
 * missing or malformed id throws and fails the build. It never falls back to
 * another environment's id: a fallback that silently picks the wrong one is
 * exactly the bug this exists to remove.
 */
export function resolveAppId({ appDir, env = process.env }: ResolveAppIdOptions): string {
  const configPath = env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH
    ? resolve(env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH)
    : resolve(appDir, 'wrangler.toml')
  const envName = env.CLOUDFLARE_ENV
  const section = envName ? `[env.${envName}.vars]` : '[vars]'

  const appId = readAppIdVar(readWranglerConfigFile(configPath), envName)
  if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) {
    // A fresh-but-uninitialized scaffold (signed out at scaffold time) still
    // carries the __APP_ID__ placeholder — the remedy is registration, not
    // hand-writing an id (ids are server-minted at `deepspace app init`).
    const uninitialized = appId === undefined || appId === '__APP_ID__'
    throw new Error(
      `${configPath}: ${section} has no valid DEEPSPACE_APP_ID ` +
        `(found ${appId === undefined ? 'nothing' : JSON.stringify(appId)}). ` +
        `The browser keys its RecordRooms to this id, so the build stops rather than ship a wrong or empty one. ` +
        (uninitialized
          ? `Run \`npx deepspace app init${envName ? ` --env ${envName}` : ''}\` to register this app — ids are server-minted; never hand-write one.`
          : `Add the id your \`deepspace app init\` registered under ${section}.`) +
        (envName ? ` Environments do not inherit the top-level id; each one is its own app.` : ``),
    )
  }
  return appId
}

/**
 * Vite `define` entry consumed by an app's `vite.config.ts` and
 * `vitest.config.ts`, so unit tests see the same id the bundle is built with:
 *
 * ```ts
 * import { fileURLToPath } from 'node:url'
 * import { appIdDefine } from 'deepspace/build'
 * export default defineConfig({
 *   define: appIdDefine({ appDir: fileURLToPath(new URL('.', import.meta.url)) }),
 * })
 * ```
 */
export function appIdDefine(options: ResolveAppIdOptions): Record<string, string> {
  return { __DEEPSPACE_APP_ID__: JSON.stringify(resolveAppId(options)) }
}

/**
 * How an app scaffolded before the build-injected id adopts it: one edit per
 * file, stated ONCE so the deploy refusals (`app_id_env_mismatch`,
 * `app_id_define_unsubstituted`) and `app update` guidance cannot disagree
 * about what it is. Keyed by the file each manual edit lands in.
 */
export const APP_ID_ADOPTION_EDITS = {
  'vite.config.ts':
    `import { deepspaceBuild } from 'deepspace/build' and add\n` +
    `    deepspaceBuild({ appDir: fileURLToPath(new URL('.', import.meta.url)) }) to plugins`,
  'vitest.config.ts': `import { appIdDefine } and set define: appIdDefine({ appDir })`,
  'src/constants.ts':
    `declare const __DEEPSPACE_APP_ID__: string; export it as APP_ID\n` +
    `    (drop the frozen literal)`,
} as const

/** The three edits are one change; this is the sentence that says so. */
export const APP_ID_ADOPTION_TOGETHER =
  `Apply all three together: src/constants.ts on its own builds clean and then throws ` +
  `in the browser. A newly scaffolded app already has this.`

/** The full retrofit as the deploy refusals print it. */
export const APP_ID_ADOPTION_STEPS =
  `Point the client at the build-injected id — the SDK's \`deepspace/build\` supplies it:\n` +
  Object.entries(APP_ID_ADOPTION_EDITS)
    .map(([file, edit]) => `  • ${file}: ${edit}\n`)
    .join('') +
  APP_ID_ADOPTION_TOGETHER
