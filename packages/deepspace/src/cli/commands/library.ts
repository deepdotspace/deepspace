/**
 * deepspace library [publish|unpublish] [options]
 *
 * Manage entries in the DeepSpace community library (lives at
 * deepdotspace-site.app.space by default; override with --library-app
 * or DEEPSPACE_LIBRARY_HOST). Subcommands POST to that app's
 * `library.publish` / `library.unpublish` actions as the currently
 * logged-in user.
 *
 * The publish action verifies the caller owns the deployed app (by
 * checking the deploy worker's `/api/apps` registry) before writing
 * the row, so publishing another user's app is rejected server-side.
 *
 * Usage:
 *   deepspace library publish                                 (uses wrangler.toml)
 *   deepspace library publish --app my-cool-app --name "My Cool App"
 *   deepspace library publish --description "..." --category Productivity
 *   deepspace library publish --tags utility,ai --visibility unlisted
 *   deepspace library unpublish <handle>
 */

import { defineCommand } from 'citty'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import * as p from '@clack/prompts'

import { ensureToken } from '../auth'
import { resolveAppName } from '../../server/rooms/app-name'

const DEFAULT_LIBRARY_APP = 'deepdotspace-site'

const publish = defineCommand({
  meta: {
    name: 'publish',
    description: 'Publish the current app to the DeepSpace library',
  },
  args: {
    dir: {
      type: 'string',
      description: 'App directory (default: current directory)',
      required: false,
    },
    app: {
      type: 'string',
      description: 'App name (default: read from wrangler.toml)',
      required: false,
    },
    name: {
      type: 'string',
      description: 'Display name (default: app name)',
      required: false,
    },
    description: {
      type: 'string',
      description: 'Short description',
      required: false,
    },
    category: {
      type: 'string',
      description: 'Category (e.g. Productivity, Finance, AI). Default: General',
      required: false,
    },
    tags: {
      type: 'string',
      description: 'Comma-separated tags',
      required: false,
    },
    visibility: {
      type: 'string',
      description: "'public' (default), 'unlisted', or 'private'",
      required: false,
    },
    screenshot: {
      type: 'string',
      description: 'Override the auto-captured preview with a public PNG URL',
      required: false,
    },
    'library-app': {
      type: 'string',
      description: `Target library app subdomain (default: ${DEFAULT_LIBRARY_APP})`,
      required: false,
    },
    json: {
      type: 'boolean',
      description: 'Print only the JSON response (machine-readable)',
      default: false,
    },
  },
  async run({ args }) {
    const json = !!args.json
    const intro = (s: string) => { if (!json) p.intro(s) }
    const info = (s: string) => { if (!json) p.log.info(s) }
    const die = (msg: string) => {
      if (json) console.error(JSON.stringify({ ok: false, error: msg }))
      else p.cancel(msg)
      process.exit(1)
    }

    intro('Publishing to the DeepSpace library')

    let appName = typeof args.app === 'string' && args.app.trim() ? args.app.trim() : undefined
    if (!appName) {
      const appDir = resolve(typeof args.dir === 'string' && args.dir ? args.dir : '.')
      const wranglerPath = join(appDir, 'wrangler.toml')
      if (!existsSync(wranglerPath)) {
        return die("No --app provided and no wrangler.toml found. Either pass --app <name> or run from your app's directory.")
      }
      const cfg = parseToml(readFileSync(wranglerPath, 'utf-8')) as { name?: string }
      const nameRes = resolveAppName(cfg.name)
      if (!nameRes.ok) return die(`wrangler.toml: ${nameRes.reason}`)
      appName = nameRes.name
    }
    info(`App: ${appName}`)

    const visibility = (args.visibility ?? 'public') as string
    if (!['public', 'private', 'unlisted'].includes(visibility)) {
      return die("--visibility must be 'public', 'unlisted', or 'private'.")
    }

    const tags = typeof args.tags === 'string' && args.tags
      ? args.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : undefined

    const libraryApp = typeof args['library-app'] === 'string' && args['library-app']
      ? args['library-app']
      : DEFAULT_LIBRARY_APP
    const libraryHost = process.env.DEEPSPACE_LIBRARY_HOST ?? `https://${libraryApp}.app.space`

    let token: string
    try {
      token = await ensureToken()
    } catch (err) {
      return die(err instanceof Error ? err.message : String(err))
    }

    const payload: Record<string, unknown> = {
      appName,
      ...(args.name ? { name: args.name } : {}),
      ...(args.description ? { description: args.description } : {}),
      ...(args.category ? { category: args.category } : {}),
      ...(tags ? { tags } : {}),
      visibility,
      ...(args.screenshot ? { screenshotUrl: args.screenshot } : {}),
    }

    const url = `${libraryHost}/api/actions/library.publish`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      })
    } catch (err) {
      return die(`Network error reaching ${url}: ${err instanceof Error ? err.message : String(err)}`)
    }

    const body = await res.text()
    let parsed: { success?: boolean; data?: { templateHandle?: string; url?: string; version?: number }; error?: string }
    try {
      parsed = JSON.parse(body)
    } catch {
      return die(`Server returned non-JSON (${res.status}): ${body.slice(0, 400)}`)
    }

    if (json) {
      console.log(JSON.stringify(parsed))
      process.exit(parsed.success ? 0 : 1)
    }

    if (!parsed.success) {
      return die(parsed.error ?? `Publish failed (HTTP ${res.status}).`)
    }

    p.log.success(`Published ${appName} as ${parsed.data?.templateHandle} (v${parsed.data?.version})`)
    if (parsed.data?.url) p.log.message(parsed.data.url)
    p.outro('Done')
  },
})

const unpublish = defineCommand({
  meta: {
    name: 'unpublish',
    description: 'Remove a library entry (owner or admin only)',
  },
  args: {
    handle: {
      type: 'positional',
      description: 'templateHandle to remove (usually your app name)',
      required: true,
    },
    'library-app': {
      type: 'string',
      description: `Target library app subdomain (default: ${DEFAULT_LIBRARY_APP})`,
      required: false,
    },
    json: {
      type: 'boolean',
      description: 'Print only the JSON response',
      default: false,
    },
  },
  async run({ args }) {
    const json = !!args.json
    const die = (msg: string) => {
      if (json) console.error(JSON.stringify({ ok: false, error: msg }))
      else p.cancel(msg)
      process.exit(1)
    }
    if (!json) p.intro('Unpublishing library entry')

    let token: string
    try { token = await ensureToken() } catch (err) {
      return die(err instanceof Error ? err.message : String(err))
    }

    const libraryApp = typeof args['library-app'] === 'string' && args['library-app']
      ? args['library-app']
      : DEFAULT_LIBRARY_APP
    const libraryHost = process.env.DEEPSPACE_LIBRARY_HOST ?? `https://${libraryApp}.app.space`

    const res = await fetch(`${libraryHost}/api/actions/library.unpublish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ templateHandle: String(args.handle) }),
    })
    const body = await res.text()
    let parsed: { success?: boolean; error?: string; data?: { templateHandle?: string } }
    try { parsed = JSON.parse(body) } catch {
      return die(`Server returned non-JSON (${res.status}): ${body.slice(0, 400)}`)
    }
    if (json) { console.log(JSON.stringify(parsed)); process.exit(parsed.success ? 0 : 1) }
    if (!parsed.success) return die(parsed.error ?? `HTTP ${res.status}`)
    p.log.success(`Unpublished ${parsed.data?.templateHandle}`)
    p.outro('Done')
  },
})

export default defineCommand({
  meta: {
    name: 'library',
    description: 'Manage your DeepSpace library entries',
  },
  subCommands: {
    publish,
    unpublish,
  },
})
