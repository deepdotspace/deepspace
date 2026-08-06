/**
 * deepspace app files — the app's own R2 allocation, from the command line.
 *
 * Every app gets a prefix in `deepspace-app-files` (docs/platform/r2-storage.md).
 * The app reaches it at runtime through `/api/files`; this is the same storage
 * reached as the app's OWNER, so images and other media can be published
 * without a deploy and without living in Git history — which is what the repo
 * size ceilings push large media towards.
 *
 * Subcommands:
 *   put <local> [--key k]   — upload (or overwrite) one file
 *   list [--prefix p]       — list the app's files
 *   get <key> [--out f]     — download one file
 *   rm <key>                — delete one file
 *
 * `put` streams: a file past the single-request bound is chunked and sent as
 * parts, so uploading a 1 GiB video costs one part of memory rather than one
 * file. Transport details live in lib/app-files-api.ts.
 *
 * Keys are relative to the app: `logo.png`, `img/hero.jpg`. The server owns
 * the physical prefix and validates every key against it, so a key can never
 * address another app.
 *
 * `--app` targets an app id or live name like the other app commands and
 * defaults to the cwd's app. Defined with the command runtime (lib/command.ts),
 * so `--json`, the envelope, and the exit codes come from there.
 */

import { defineCommand } from 'citty'
import { basename, resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { resolveAppTarget } from '../lib/app-target'
import { defineDeepspaceCommand, Refusal } from '../lib/command'
import { createSpinner } from '../lib/spinner'
import {
  deleteAppFile,
  downloadAppFile,
  encodeKeyPath,
  formatBytes,
  listAppFiles,
  MAX_APP_FILE_BYTES,
  uploadAppFile,
} from '../lib/app-files-api'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy
const PLATFORM_URL = process.env.DEEPSPACE_PLATFORM_URL ?? PLATFORM_URLS.platform

/**
 * Two services, deliberately. The app registry that turns a name into an id
 * lives on the deploy worker; the files themselves live on the platform
 * worker. So resolution reads DEPLOY_URL and every file call uses
 * PLATFORM_URL, and each reports its own URL when unreachable.
 */
async function target(app: unknown): Promise<{ token: string; appId: string }> {
  const token = await ensureToken()
  const appId = await resolveAppTarget(DEPLOY_URL, token, app as string | undefined)
  return { token, appId }
}

/** R2 serves at most 1000 keys per list and there is no cursor here yet. */
const MAX_LIST_LIMIT = 1000

function parseLimit(raw: unknown): number {
  const limit = Number(raw ?? 100)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new Refusal(`--limit must be a whole number from 1 to ${MAX_LIST_LIMIT}.`, 'invalid_limit')
  }
  return limit
}

/** Reject a key the server would refuse anyway, with a better sentence. */
export function requireKey(raw: string): string {
  const key = raw.trim().replace(/^\/+/, '')
  if (!key) throw new Refusal('A key is required (for example `logo.png`).', 'invalid_key')
  if (key.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new Refusal(
      `"${raw}" contains a path traversal segment. Keys are relative to the app, e.g. \`img/hero.jpg\`.`,
      'invalid_key',
    )
  }
  return key
}

/**
 * Strip the server's mounted prefix so listings read in the same relative keys
 * every other subcommand takes. The prefix is `apps/<resourceId>/` — always
 * the first two segments — so it is taken by segment count rather than by
 * pattern; a key may legitimately contain any character, newlines included.
 */
export function appPrefixOf(key: string): string {
  const segments = key.split('/')
  return segments.length > 2 ? `${segments[0]}/${segments[1]}/` : ''
}

export function relativeKey(key: string, prefix: string): string {
  return prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key
}

/** Where a file is served from, on the app's own origin. */
export function servedPath(key: string): string {
  return `/api/files/${encodeKeyPath(key)}?scope=app`
}

// ============================================================================
// put
// ============================================================================

const put = defineDeepspaceCommand({
  meta: {
    name: 'put',
    description: `Upload a file to the app’s files (${formatBytes(MAX_APP_FILE_BYTES)} per file)`,
  },
  args: {
    file: { type: 'positional', description: 'Local file to upload', required: true },
    key: { type: 'string', description: 'Key to store it under (default: the file name)' },
    app: { type: 'string', description: 'App id or live name (defaults to ./wrangler.toml)' },
  },
  async run({ args }) {
    const localPath = resolve(String(args.file))
    if (!existsSync(localPath) || !statSync(localPath).isFile()) {
      throw new Refusal(`No such file: ${args.file}`, 'file_not_found')
    }
    const key = requireKey((args.key as string | undefined) ?? basename(localPath))
    const { token, appId } = await target(args.app)

    // A chunked upload can run for minutes. Report each part as it lands —
    // the spinner already knows to print one static line per phase when
    // stdout is not a TTY, so an agent log gets progress without repaint noise.
    const spinner = args.json ? null : createSpinner()
    let started = false
    const result = await uploadAppFile(
      PLATFORM_URL,
      token,
      appId,
      localPath,
      key,
      (sent, total, part, parts) => {
        if (parts === 1 || !spinner) return
        if (!started) {
          spinner.start(`Uploading ${key} in ${parts} parts`)
          started = true
        }
        spinner.message(
          `${key} — part ${part}/${parts} (${formatBytes(sent)} of ${formatBytes(total)})`,
        )
      },
    ).finally(() => {
      if (started) spinner?.stop()
    })

    if (!args.json) {
      const how = result.parts > 1 ? ` in ${result.parts} parts` : ''
      console.log(`✓ ${key} (${formatBytes(result.size)})${how}`)
      console.log(`  Served from your app at ${servedPath(result.key)}`)
    }
    return {
      data: {
        appId,
        key,
        storedKey: result.key,
        size: result.size,
        parts: result.parts,
        path: servedPath(result.key),
      },
    }
  },
})

// ============================================================================
// list
// ============================================================================

const list = defineDeepspaceCommand({
  meta: { name: 'list', description: 'List the app’s files' },
  args: {
    prefix: { type: 'string', description: 'Only keys starting with this prefix' },
    limit: {
      type: 'string',
      description: `Max entries, 1-${MAX_LIST_LIMIT} (default 100)`,
      default: '100',
    },
    app: { type: 'string', description: 'App id or live name (defaults to ./wrangler.toml)' },
  },
  async run({ args }) {
    const limit = parseLimit(args.limit)
    const { token, appId } = await target(args.app)
    const query = new URLSearchParams({ limit: String(limit) })
    if (args.prefix) query.set('prefix', String(args.prefix))
    const result = await listAppFiles(PLATFORM_URL, token, appId, query)
    // Every key in one response shares the mounted prefix.
    const prefix = result.files.length ? appPrefixOf(result.files[0].key) : ''
    const files = result.files.map((file) => ({
      key: relativeKey(file.key, prefix),
      size: file.size,
      uploaded: file.uploaded,
      path: servedPath(file.key),
    }))

    if (!args.json) {
      if (files.length === 0) {
        console.log('No files. Upload one with `deepspace app files put <file>`.')
      } else {
        const keyWidth = Math.max(3, ...files.map((file) => file.key.length))
        console.log(`${'KEY'.padEnd(keyWidth)}  ${'SIZE'.padStart(9)}  UPLOADED`)
        for (const file of files) {
          console.log(
            `${file.key.padEnd(keyWidth)}  ${formatBytes(file.size).padStart(9)}  ${file.uploaded.slice(0, 10)}`,
          )
        }
        // No cursor: at MAX_LIST_LIMIT the only way to see more is --prefix.
        const more = limit < MAX_LIST_LIMIT ? 'raise --limit or narrow with --prefix' : 'narrow with --prefix'
        if (result.truncated) console.log(`(truncated at ${limit} — ${more})`)
      }
    }
    return { data: { appId, files, truncated: result.truncated } }
  },
})

// ============================================================================
// get
// ============================================================================

const get = defineDeepspaceCommand({
  meta: { name: 'get', description: 'Download one file' },
  args: {
    key: { type: 'positional', description: 'Key to download', required: true },
    out: { type: 'string', description: 'Write here (default: the key’s file name)' },
    app: { type: 'string', description: 'App id or live name (defaults to ./wrangler.toml)' },
  },
  async run({ args }) {
    const key = requireKey(String(args.key))
    const destination = resolve(String(args.out ?? basename(key)))
    const { token, appId } = await target(args.app)
    const result = await downloadAppFile(PLATFORM_URL, token, appId, key, destination)

    if (!args.json) console.log(`✓ ${key} → ${destination} (${formatBytes(result.bytes)})`)
    return { data: { appId, key, out: destination, size: result.bytes, contentType: result.contentType } }
  },
})

// ============================================================================
// rm
// ============================================================================

const rm = defineDeepspaceCommand({
  meta: { name: 'rm', description: 'Delete one file' },
  args: {
    key: { type: 'positional', description: 'Key to delete', required: true },
    app: { type: 'string', description: 'App id or live name (defaults to ./wrangler.toml)' },
  },
  async run({ args }) {
    const key = requireKey(String(args.key))
    const { token, appId } = await target(args.app)
    const { existed } = await deleteAppFile(PLATFORM_URL, token, appId, key)
    // The API is idempotent on purpose (deployed apps depend on that), but a
    // person typing a key wants to know they hit nothing — a `✓ deleted` for a
    // typo reads as "the file is gone" when it was never there.
    if (!existed) {
      throw new Refusal(
        `No file at ${key} — nothing was deleted. Check the key with \`deepspace app files list\`.`,
        'file_not_found',
      )
    }
    if (!args.json) console.log(`✓ deleted ${key}`)
    // Terminal: what to upload next is the caller's business.
    return { data: { appId, key, deleted: true } }
  },
})

// ============================================================================
// Top-level
// ============================================================================

// No `run()` on the parent — citty otherwise calls it after every subcommand
// finishes, which prints spurious help text.
export default defineCommand({
  meta: { name: 'files', description: 'Upload and manage the app’s files (images, media)' },
  subCommands: { put, list, get, rm },
})
