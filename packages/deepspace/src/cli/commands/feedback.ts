/**
 * deepspace feedback
 *
 * Submit a bug report, feature request, or general feedback to the DeepSpace
 * team. The report is authenticated as the logged-in user and POSTed to the
 * api-worker, where it lands in the admin triage queue (dashboard ·
 * Admin · Feedback).
 *
 * Interactive when run in a TTY (prompts for type/title/details); flag-driven
 * for agents and CI. The title is a positional argument; the details go in
 * --message (-m). Both are required for non-interactive use.
 *
 *   deepspace feedback                                          # full interactive prompt
 *   deepspace feedback "Crash on deploy" -m "It explodes when…" # quick, non-interactive
 *   deepspace feedback -t feature "Add dark mode" -m "…" --yes --json
 *
 * Best-effort environment context (CLI version, Node version, OS, and the
 * current app name if run inside a scaffolded app) is attached automatically
 * so the team can reproduce issues without a round-trip.
 */

import { defineCommand } from 'citty'
import * as p from '@clack/prompts'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { release } from 'node:os'
import { ensureToken } from '../auth'
import { PLATFORM_URLS, DASHBOARD_URL } from '../env'
import { apiFetch } from '../lib/api'
import { hasWranglerConfig, readWranglerConfig } from '../lib/wrangler-env'

const API_URL = process.env.DEEPSPACE_API_URL ?? PLATFORM_URLS.api

const TYPES = ['bug', 'feature', 'other'] as const
type FeedbackType = (typeof TYPES)[number]

const TYPE_LABELS: Record<FeedbackType, string> = {
  bug: 'Bug report',
  feature: 'Feature request',
  other: 'Other feedback',
}

// Mirror the api-worker's limits so over-length input fails fast with a clear
// field-specific message instead of a generic 400 after the round-trip.
const MAX_TITLE_LEN = 200
const MAX_BODY_LEN = 10_000
const MAX_CONTEXT_LEN = 200

interface FeedbackContext {
  cliVersion: string
  nodeVersion: string
  platform: string
  appName?: string
}

interface FeedbackPayload extends FeedbackContext {
  type: FeedbackType
  title: string
  body: string
}

interface FeedbackReport {
  id: string
  type: FeedbackType
  title: string
  status: string
  createdAt: string
}

const api = <T>(token: string, path: string, init?: RequestInit): Promise<T> =>
  apiFetch<T>(API_URL, token, path, init)

/** Normalize/validate a `--type` value. Throws on an unknown type. */
export function normalizeType(raw: string | undefined): FeedbackType {
  const value = (raw ?? 'bug').toLowerCase()
  if ((TYPES as readonly string[]).includes(value)) return value as FeedbackType
  throw new Error(`Invalid --type "${raw}". Use one of: ${TYPES.join(', ')}.`)
}

/** Read the deepspace CLI version from its own package.json. */
function readCliVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    // Bundled output lives in <pkg>/dist (package.json one level up); the
    // source tree has it three levels up from src/cli/commands.
    const candidates = [
      join(here, '..', 'package.json'),
      join(here, '..', '..', '..', 'package.json'),
    ]
    for (const path of candidates) {
      if (!existsSync(path)) continue
      const pkg = JSON.parse(readFileSync(path, 'utf-8')) as {
        name?: string
        version?: string
      }
      if (pkg.name === 'deepspace' && pkg.version) return pkg.version
    }
  } catch {
    // fall through
  }
  return 'unknown'
}

/** Best-effort app name from the current dir's wrangler.toml, if any. */
function detectAppName(): string | undefined {
  try {
    const cwd = process.cwd()
    if (!hasWranglerConfig(cwd)) return undefined
    const config = readWranglerConfig(cwd)
    return typeof config.name === 'string' ? config.name : undefined
  } catch {
    return undefined
  }
}

/** Clamp a best-effort context value so it can never block submission. */
function clampContext(value: string): string {
  return value.length > MAX_CONTEXT_LEN ? value.slice(0, MAX_CONTEXT_LEN) : value
}

/** Collect the environment context attached to every report. */
export function collectContext(): FeedbackContext {
  const appName = detectAppName()
  return {
    cliVersion: clampContext(readCliVersion()),
    nodeVersion: clampContext(process.version),
    platform: clampContext(`${process.platform} ${release()}`),
    ...(appName ? { appName: clampContext(appName) } : {}),
  }
}

/** Assemble the request body. Trims and validates title/body are non-empty. */
export function buildFeedbackPayload(input: {
  type: string | undefined
  title: string
  body: string
  context: FeedbackContext
}): FeedbackPayload {
  const title = input.title.trim()
  const body = input.body.trim()
  if (!title) throw new Error('A title is required.')
  if (!body) throw new Error('A message/description is required.')
  if (title.length > MAX_TITLE_LEN) {
    throw new Error(`Title must be ${MAX_TITLE_LEN} characters or fewer (got ${title.length}).`)
  }
  if (body.length > MAX_BODY_LEN) {
    throw new Error(`Description must be ${MAX_BODY_LEN} characters or fewer (got ${body.length}).`)
  }
  return {
    type: normalizeType(input.type),
    title,
    body,
    ...input.context,
  }
}

export default defineCommand({
  meta: {
    name: 'feedback',
    description: 'Submit a bug report, feature request, or feedback to DeepSpace',
  },
  args: {
    title: {
      type: 'positional',
      description: 'Short summary (prompted if omitted in a terminal)',
      required: false,
    },
    type: {
      type: 'string',
      alias: 't',
      description: `Report type: ${TYPES.join(' | ')} (default: bug)`,
      required: false,
    },
    message: {
      type: 'string',
      alias: 'm',
      description: 'Details / description (prompted if omitted in a terminal)',
      required: false,
    },
    yes: {
      type: 'boolean',
      description: 'Skip the confirmation prompt',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Emit JSON instead of human output',
      default: false,
    },
  },
  async run({ args }) {
    const interactive = process.stdin.isTTY && !args.json

    // Fail consistently: under --json, emit the same { ok, error } shape on
    // stdout that the success/network paths use, so an agent can always parse
    // the outcome. Otherwise print to stderr. Either way exit non-zero.
    const fail = (message: string): never => {
      if (args.json) {
        process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n')
      } else {
        console.error(message)
      }
      process.exit(1)
    }

    let type: FeedbackType
    try {
      type = normalizeType(args.type ? String(args.type) : undefined)
    } catch (err) {
      return fail((err as Error).message)
    }

    let title = args.title ? String(args.title) : ''
    let body = args.message ? String(args.message) : ''

    // Non-interactive callers (agents/CI) must supply both fields up front.
    if ((!title || !body) && !interactive) {
      return fail(
        'Provide a title and --message to submit non-interactively, ' +
          'e.g. `deepspace feedback "Title" --message "Details"`.',
      )
    }

    // Prompt for whatever is still missing — including the type, so an
    // interactive user who passed --title/--message but no --type is still
    // asked rather than having it silently default to "bug".
    if (interactive && (!args.type || !title || !body)) {
      p.intro('DeepSpace Feedback')

      if (!args.type) {
        const picked = await p.select({
          message: 'What kind of feedback is this?',
          options: TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] })),
          initialValue: type,
        })
        if (p.isCancel(picked)) {
          p.cancel('Cancelled.')
          process.exit(0)
        }
        type = picked as FeedbackType
      }

      if (!title) {
        const t = await p.text({
          message: 'Title',
          placeholder: 'Short summary of the issue',
          validate: (v) => {
            if (!v?.trim()) return 'Title is required'
            if (v.length > MAX_TITLE_LEN)
              return `Title must be ${MAX_TITLE_LEN} characters or fewer`
            return undefined
          },
        })
        if (p.isCancel(t)) {
          p.cancel('Cancelled.')
          process.exit(0)
        }
        title = String(t)
      }

      if (!body) {
        const m = await p.text({
          message: 'Details',
          placeholder: 'What happened? Steps to reproduce, what you expected…',
          validate: (v) => {
            if (!v?.trim()) return 'A description is required'
            if (v.length > MAX_BODY_LEN)
              return `Description must be ${MAX_BODY_LEN} characters or fewer`
            return undefined
          },
        })
        if (p.isCancel(m)) {
          p.cancel('Cancelled.')
          process.exit(0)
        }
        body = String(m)
      }
    }

    let payload: FeedbackPayload
    try {
      payload = buildFeedbackPayload({
        type,
        title,
        body,
        context: collectContext(),
      })
    } catch (err) {
      return fail((err as Error).message)
    }

    // Confirmation — only when interactive and not explicitly skipped.
    if (interactive && !args.yes) {
      p.note(
        `${TYPE_LABELS[payload.type]}\n${payload.title}\n\n${payload.body}` +
          `\n\nContext: deepspace ${payload.cliVersion} · ${payload.nodeVersion} · ${payload.platform}` +
          (payload.appName ? ` · app ${payload.appName}` : ''),
        'Review',
      )
      const ok = await p.confirm({ message: 'Send this to the DeepSpace team?' })
      if (p.isCancel(ok) || !ok) {
        p.cancel('Not sent.')
        process.exit(0)
      }
    }

    let token: string
    try {
      token = await ensureToken()
    } catch (err) {
      return fail((err as Error).message ?? 'Not signed in. Run `deepspace login`.')
    }

    let result: { report: FeedbackReport }
    try {
      result = await api<{ report: FeedbackReport }>(token, '/api/feedback', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    } catch (err) {
      return fail((err as Error).message)
    }

    if (args.json) {
      process.stdout.write(JSON.stringify({ ok: true, report: result.report }) + '\n')
      return
    }

    if (interactive) {
      p.outro(`Thanks! Submitted as ${result.report.id}.`)
    } else {
      console.log(`Submitted feedback ${result.report.id} (${result.report.type}).`)
    }
    console.log(`Track triage status at ${DASHBOARD_URL}.`)
  },
})
