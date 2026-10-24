import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * A preload used only by a local test server.
 *
 * The Cloudflare Vite plugin asks Wrangler for Miniflare worker options, but
 * the public `unstable_getMiniflareWorkerOptions` helper currently drops the
 * `dev.outboundService` callback before it reaches Miniflare.  Importing
 * Wrangler once before the Vite plugin's ESM import lets us patch that
 * boundary in the child Vite process. This stays local to tests and also
 * works for existing apps whose `vite.config.ts` predates the template fix.
 * NODE_OPTIONS reaches every Node process of the run (npx, Playwright and its
 * workers), so the preload only loads Wrangler inside the Vite CLI.
 */
const HOOK_SOURCE = String.raw`import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const isVite = /[\\/]vite(?:[\\/]bin[\\/]vite\.js)?$/.test(process.argv[1] ?? '')
const loaded = isVite ? require('wrangler') : undefined
const marker = Symbol.for('deepspace.nodeOutboundHook')
if (loaded && !loaded[marker]) {
  const original = loaded.unstable_getMiniflareWorkerOptions
  if (typeof original === 'function') {
    loaded.unstable_getMiniflareWorkerOptions = function deepspaceOutboundOptions(...args) {
      const options = original.apply(this, args)
      if (options?.workerOptions && options.workerOptions.outboundService === undefined) {
        options.workerOptions.outboundService = async (request) => {
          // The Request comes from workerd's realm. Passing it directly to
          // undici makes Node try to parse "[object Request]" as a URL, so
          // rebuild the small fetch init in the parent Node realm first.
          const url = typeof request?.url === 'string' ? request.url : String(request?.url ?? '')
          if (!url) throw new TypeError('DeepSpace outbound request has no URL')
          const method = String(request?.method ?? 'GET').toUpperCase()
          const headers = new Headers()
          if (request?.headers && typeof request.headers.forEach === 'function') {
            request.headers.forEach((value, name) => headers.set(name, value))
          }
          // Miniflare hands over every request as redirect 'follow', and
          // workerd follows redirects itself for requests that asked to, so
          // Node must return each response as-is.
          const init = { method, headers, redirect: 'manual' }
          if (method !== 'GET' && method !== 'HEAD' && typeof request?.arrayBuffer === 'function') {
            init.body = await request.arrayBuffer()
          }
          return globalThis.fetch(url, init)
        }
      }
      return options
    }
    loaded[marker] = true
  }
}

`

/**
 * Write the child-process preload into the app's ignored state directory.
 * Its content is constant, so concurrent runs share one file and it is only
 * rewritten when missing or different.
 */
export function writeNodeOutboundHook(appDir: string): string {
  const stateDir = join(appDir, '.deepspace')
  mkdirSync(stateDir, { recursive: true })
  const hookPath = join(stateDir, 'node-outbound-hook.mjs')
  if (!existsSync(hookPath) || readFileSync(hookPath, 'utf8') !== HOOK_SOURCE) {
    writeFileSync(hookPath, HOOK_SOURCE, { encoding: 'utf8', mode: 0o600 })
    chmodSync(hookPath, 0o600)
  }
  return hookPath
}

/** Add a Node preload to an existing NODE_OPTIONS value. */
export function nodeOptionsWithOutboundHook(
  existing: string | undefined,
  hookPath: string,
): string {
  // --import takes a module specifier, so a Windows drive path must be a
  // file URL. Node parses quoted values in NODE_OPTIONS itself.
  const option = `--import ${JSON.stringify(pathToFileURL(hookPath).href)}`
  return [existing?.trim(), option].filter(Boolean).join(' ')
}
