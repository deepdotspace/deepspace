/**
 * deepspace app library [publish|unpublish] [options]
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
 * Defined with the command runtime (lib/command.ts). That fixes this file's
 * long-standing deviation: both subcommands used to write their `--json`
 * envelope to STDERR (and the success envelope as the server's raw
 * `{success,data}` blob). It is now a single-line `{ ok, … }` document on
 * STDOUT, like every other command.
 *
 * Usage:
 *   deepspace app library publish                                 (uses wrangler.toml)
 *   deepspace app library publish --app my-cool-app --name "My Cool App"
 *   deepspace app library publish --description "..." --category Productivity
 *   deepspace app library publish --tags utility,ai --visibility unlisted
 *   deepspace app library unpublish <handle>
 */

import { defineCommand } from 'citty'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import * as p from '@clack/prompts'

import { ensureToken } from '../auth'
import { parseAppArg } from '../lib/app-target'
import { resolveAppName } from '../../server/rooms/app-name'
import { cliAction, defineDeepspaceCommand, Refusal } from '../lib/command'

const DEFAULT_LIBRARY_APP = 'deepdotspace-site'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const publish = defineDeepspaceCommand({
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
  },
  async run({ args }) {
    const json = args.json
    const intro = (s: string) => { if (!json) p.intro(s) }
    const info = (s: string) => { if (!json) p.log.info(s) }

    intro('Publishing to the DeepSpace library')

    // An explicit blank --app must error, not silently fall back to the cwd app.
    const appErr = parseAppArg(str(args.app)).error
    if (appErr) throw new Refusal(appErr, 'invalid_app')
    let appName = str(args.app)?.trim()
    if (!appName) {
      const appDir = resolve(str(args.dir) ?? '.')
      const wranglerPath = join(appDir, 'wrangler.toml')
      if (!existsSync(wranglerPath)) {
        throw new Refusal(
          "No --app provided and no wrangler.toml found. Either pass --app <name> or run from your app's directory.",
          'not_in_app_repo',
        )
      }
      const cfg = parseToml(readFileSync(wranglerPath, 'utf-8')) as { name?: string }
      const nameRes = resolveAppName(cfg.name)
      if (!nameRes.ok) throw new Refusal(`wrangler.toml: ${nameRes.reason}`, 'invalid_config')
      appName = nameRes.name
    }
    info(`App: ${appName}`)

    const visibility = (str(args.visibility) ?? 'public') as string
    if (!['public', 'private', 'unlisted'].includes(visibility)) {
      throw new Refusal("--visibility must be 'public', 'unlisted', or 'private'.", 'invalid_visibility')
    }

    const tags = str(args.tags)
      ? String(args.tags).split(',').map((t) => t.trim()).filter(Boolean)
      : undefined

    const libraryApp = str(args['library-app']) ?? DEFAULT_LIBRARY_APP
    const libraryHost = process.env.DEEPSPACE_LIBRARY_HOST ?? `https://${libraryApp}.app.space`

    let token: string
    try {
      token = await ensureToken()
    } catch (err) {
      throw new Refusal(err instanceof Error ? err.message : String(err), 'not_authenticated', {
        action: cliAction('deepspace', 'auth', 'login'),
      })
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
      throw new Refusal(
        `Network error reaching ${url}: ${err instanceof Error ? err.message : String(err)}`,
        'network_error',
      )
    }

    const body = await res.text()
    let parsed: { success?: boolean; data?: { templateHandle?: string; url?: string; version?: number }; error?: string }
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new Refusal(`Server returned non-JSON (${res.status}): ${body.slice(0, 400)}`, 'invalid_response')
    }

    if (!parsed.success) {
      throw new Refusal(parsed.error ?? `Publish failed (HTTP ${res.status}).`, 'publish_failed')
    }

    if (!json) {
      p.log.success(`Published ${appName} as ${parsed.data?.templateHandle} (v${parsed.data?.version})`)
      if (parsed.data?.url) p.log.message(parsed.data.url)
      p.outro('Done')
    }
    return {
      data: {
        appName,
        templateHandle: parsed.data?.templateHandle ?? null,
        url: parsed.data?.url ?? null,
        version: parsed.data?.version ?? null,
        visibility,
      },
    }
  },
})

const unpublish = defineDeepspaceCommand({
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
  },
  async run({ args }) {
    const json = args.json
    if (!json) p.intro('Unpublishing library entry')

    let token: string
    try {
      token = await ensureToken()
    } catch (err) {
      throw new Refusal(err instanceof Error ? err.message : String(err), 'not_authenticated', {
        action: cliAction('deepspace', 'auth', 'login'),
      })
    }

    const libraryApp = str(args['library-app']) ?? DEFAULT_LIBRARY_APP
    const libraryHost = process.env.DEEPSPACE_LIBRARY_HOST ?? `https://${libraryApp}.app.space`

    const res = await fetch(`${libraryHost}/api/actions/library.unpublish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ templateHandle: String(args.handle) }),
    })
    const body = await res.text()
    let parsed: { success?: boolean; error?: string; data?: { templateHandle?: string } }
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new Refusal(`Server returned non-JSON (${res.status}): ${body.slice(0, 400)}`, 'invalid_response')
    }
    if (!parsed.success) {
      throw new Refusal(parsed.error ?? `HTTP ${res.status}`, 'unpublish_failed')
    }
    if (!json) {
      p.log.success(`Unpublished ${parsed.data?.templateHandle}`)
      p.outro('Done')
    }
    // Terminal: nothing follows an unpublish.
    return { data: { templateHandle: parsed.data?.templateHandle ?? String(args.handle) } }
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
