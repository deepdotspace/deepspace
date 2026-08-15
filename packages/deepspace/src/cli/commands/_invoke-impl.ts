/**
 * Implementation for `deepspace integrations list`, `info`, and `invoke`.
 *
 * The CLI invokes platform integrations as the currently logged-in user
 * (the same identity shown by `deepspace auth whoami`). That user is billed.
 *
 * This module is the single source of truth for:
 *   - listing the integration catalog
 *   - showing per-endpoint info (schema + example body)
 *   - making the actual POST call
 *
 * This module is NOT a citty command, so it does not wrap itself in the
 * command runtime. Instead every `run*` here RETURNS a {@link CommandResult}
 * and throws a {@link Refusal} — exactly what a `defineDeepspaceCommand` body
 * produces — so the command definitions can let the runtime own the envelope,
 * the slug, the `Next:` line, and the exit code.
 * Nothing in here prints an envelope or calls process.exit.
 */

import { readFileSync } from 'node:fs'
import * as p from '@clack/prompts'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { cliAction, Refusal, type CommandResult } from '../lib/command'
import { normalizeApiError } from '../../shared/api-error'

const API_URL = process.env.DEEPSPACE_API_URL ?? PLATFORM_URLS.api
const DEFAULT_TIMEOUT_MS = 120_000

interface EndpointInfo {
  endpoint: string
  /** Optional as version-skew tolerance: an older server may not send it,
   *  and the render paths guard on it. */
  description?: string
  /** Present (true) only on endpoints that answer with a requiresOAuth
   *  payload until the user connects the provider. */
  requiresOAuth?: boolean
  billing: { model: string; baseCost: number; currency: string }
  inputSchema: Record<string, unknown> | null
  example: Record<string, unknown> | null
  outputSchema?: Record<string, unknown> | null
}

interface Catalog {
  integrations: Record<string, EndpointInfo[]>
}

export interface InvokeArgs {
  target: string
  body?: string
  bodyFile?: string
  json?: boolean
  timeout?: number
  yes?: boolean
}

export interface InfoArgs {
  target: string
  json?: boolean
}

export interface ListArgs {
  json?: boolean
}

/**
 * Parse "<integration>/<endpoint>" into its two segments.
 * Throws on malformed input.
 */
function parseTarget(target: string): { integration: string; endpoint: string } {
  if (!target || typeof target !== 'string') {
    throw new Refusal(
      "Missing target. Expected '<integration>/<endpoint>' (e.g. 'openai/chat-completion').",
      'missing_target',
      { action: cliAction('deepspace', 'integrations', 'list') },
    )
  }
  const parts = target.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Refusal(
      `Bad target '${target}'. Expected '<integration>/<endpoint>' (e.g. 'openai/chat-completion').`,
      'bad_target',
      { action: cliAction('deepspace', 'integrations', 'list') },
    )
  }
  return { integration: parts[0], endpoint: parts[1] }
}

/**
 * Parse the `integrations invoke --timeout` value in milliseconds.
 */
export function parseTimeout(raw: unknown): number | undefined {
  if (raw == null) return undefined
  const timeout = Number(raw)
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Refusal(
      `Invalid --timeout '${String(raw)}'. Must be a positive number of milliseconds.`,
      'invalid_timeout',
    )
  }
  return timeout
}

/**
 * Resolve the request body from --body, --body-file, or default to '{}'.
 * Errors if both --body and --body-file are provided, or the body isn't
 * valid JSON.
 */
function resolveBody(opts: { body?: string; bodyFile?: string }): string {
  if (opts.body != null && opts.bodyFile != null) {
    throw new Refusal('Pass either --body or --body-file, not both.', 'conflicting_body_args')
  }

  let raw: string
  if (opts.body != null) {
    raw = opts.body
  } else if (opts.bodyFile != null) {
    raw = opts.bodyFile === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.bodyFile, 'utf-8')
  } else {
    return '{}'
  }

  // Validate it parses as JSON so we fail fast with a clear message.
  try {
    JSON.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid JSON'
    throw new Refusal(`Body is not valid JSON: ${msg}`, 'invalid_body_json')
  }
  return raw
}

async function fetchCatalog(opts: { summary?: boolean } = {}): Promise<Catalog> {
  // `list` uses the summary view (names + billing); the full catalog with every
  // endpoint's schema is large enough to be truncated in an agent's terminal.
  // `info` omits the flag so it still gets the schema + example.
  const url = opts.summary ? `${API_URL}/api/integrations?summary=1` : `${API_URL}/api/integrations`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Refusal(`Failed to fetch integration catalog (${res.status})`, 'catalog_unavailable')
  }
  return (await res.json()) as Catalog
}

function findEndpoint(
  catalog: Catalog,
  integration: string,
  endpoint: string,
): EndpointInfo | null {
  const endpoints = catalog.integrations[integration]
  if (!endpoints) return null
  return endpoints.find((e) => e.endpoint === endpoint) ?? null
}

function formatCurrency(value: number, currency: string): string {
  if (currency === 'USD') return `$${value}`
  return `${value} ${currency}`
}

/**
 * Human-readable billing unit for a pricing model. `per_token` → "per token",
 * `per_call` → "per call". Unknown/future models render their raw `per_*` shape
 * ("per foo") or pass through, so we never mislabel one mode as another (INT-1).
 */
export function billingUnit(model: string): string {
  if (model === 'per_token') return 'per token'
  if (model === 'per_call') return 'per call'
  return model.startsWith('per_') ? model.replace(/^per_/, 'per ').replace(/_/g, ' ') : model
}

/**
 * Interactive only when BOTH streams are TTYs: p.confirm reads stdin and draws
 * to stdout, so a piped stdin (`echo {} | invoke … --body-file -`) must never
 * reach the prompt — it would hang waiting for input that can't arrive. Pure so
 * the both-streams rule is testable.
 */
export function isInteractive(
  stdin: { isTTY?: boolean },
  stdout: { isTTY?: boolean },
): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY)
}

/**
 * Whether to confirm a paid invoke before firing it (FEAT-13). Only on an
 * interactive terminal, for a non-free endpoint, when the caller hasn't asked
 * for machine output (--json) or pre-approved (--yes). Pure for testing.
 */
export function shouldConfirmCost(opts: {
  json: boolean
  yes: boolean
  isTTY: boolean
  baseCost: number
}): boolean {
  return !opts.json && !opts.yes && opts.isTTY && opts.baseCost > 0
}

/**
 * `deepspace integrations list`
 * Prints the catalog grouped by integration.
 */
export async function runList(args: ListArgs): Promise<CommandResult> {
  const catalog = await fetchCatalog({ summary: true })
  const names = Object.keys(catalog.integrations).sort()

  if (!args.json) {
    if (names.length === 0) {
      console.log('No integrations available.')
    } else {
      for (const name of names) {
        console.log(name)
        const endpoints = [...catalog.integrations[name]].sort((a, b) =>
          a.endpoint.localeCompare(b.endpoint),
        )
        const widest = Math.max(...endpoints.map((e) => e.endpoint.length))
        // Two lines per endpoint: key + billing + [oauth] flag, then the
        // description indented below — so the flag is never buried past the
        // terminal width by a long description.
        for (const ep of endpoints) {
          const pad = ep.endpoint.padEnd(widest)
          const cost = formatCurrency(ep.billing.baseCost, ep.billing.currency)
          const oauth = ep.requiresOAuth ? ' [oauth]' : ''
          console.log(`  ${pad}  ${ep.billing.model.padEnd(12)} ${cost}${oauth}`)
          if (ep.description) console.log(`    ${ep.description}`)
        }
        console.log()
      }
    }
  }

  return { data: catalog as unknown as Record<string, unknown> }
}

/**
 * `deepspace integrations info <target>`
 * Prints the schema + example body for a single endpoint.
 */
export async function runInfo(args: InfoArgs): Promise<CommandResult> {
  const { integration, endpoint } = parseTarget(args.target)
  const catalog = await fetchCatalog()
  const info = findEndpoint(catalog, integration, endpoint)

  if (!info) {
    const available = catalog.integrations[integration]
    if (!available) {
      const names = Object.keys(catalog.integrations).sort().join(', ')
      throw new Refusal(`Unknown integration '${integration}'. Available: ${names}`, 'unknown_integration', {
        action: cliAction('deepspace', 'integrations', 'list'),
      })
    }
    const endpoints = available.map((e) => e.endpoint).join(', ')
    throw new Refusal(
      `Unknown endpoint '${endpoint}' for '${integration}'. Available: ${endpoints}`,
      'unknown_endpoint',
      { action: cliAction('deepspace', 'integrations', 'list') },
    )
  }

  if (!args.json) {
    console.log(`${integration}/${endpoint}`)
    if (info.description) console.log(`  ${info.description}`)
    console.log(
      `  billing: ${formatCurrency(info.billing.baseCost, info.billing.currency)} ${billingUnit(info.billing.model)}`,
    )
    if (info.requiresOAuth) {
      console.log(
        '  Requires OAuth: without a connected account, a call succeeds with data { requiresOAuth: true, authUrl } — open the authUrl, then retry.',
      )
    }
    console.log()
    console.log('Input schema:')
    console.log(
      info.inputSchema ? JSON.stringify(info.inputSchema, null, 2) : '  (no schema registered)',
    )
    console.log()
    console.log('Example body:')
    console.log(info.example ? JSON.stringify(info.example, null, 2) : '  (no example available)')
    if (info.outputSchema) {
      console.log()
      console.log('Output schema:')
      console.log(JSON.stringify(info.outputSchema, null, 2))
    }
  }

  return { data: info as unknown as Record<string, unknown> }
}

/**
 * `deepspace integrations invoke <target>`
 * Performs the actual integration call.
 */
export async function runInvoke(args: InvokeArgs): Promise<CommandResult> {
  const { integration, endpoint } = parseTarget(args.target)
  const body = resolveBody({ body: args.body, bodyFile: args.bodyFile })
  const timeoutMs = args.timeout ?? DEFAULT_TIMEOUT_MS

  // FEAT-13: this fires a PAID call billed to the logged-in user. On a fully
  // interactive terminal, confirm the cost first (unless --yes or --json).
  // Gate on BOTH streams: p.confirm reads stdin and draws to stdout, so a piped
  // stdin (e.g. `echo {} | deepspace integrations invoke … --body-file -`) must never reach
  // the prompt — it would hang waiting for input that can't come.
  const interactive = isInteractive(process.stdin, process.stdout)
  if (!args.json && !args.yes && interactive) {
    let info: EndpointInfo | null = null
    try {
      info = findEndpoint(await fetchCatalog({ summary: true }), integration, endpoint)
    } catch {
      // Couldn't fetch billing — don't block the call, but say so, so a paid
      // call never fires completely silently. The POST still enforces
      // auth/existence and reports its own errors.
      console.error('Note: could not verify the call cost; proceeding. Pass --yes to skip this check.')
      info = null
    }
    if (
      info &&
      shouldConfirmCost({
        json: !!args.json,
        yes: !!args.yes,
        isTTY: interactive,
        baseCost: info.billing.baseCost,
      })
    ) {
      const cost = formatCurrency(info.billing.baseCost, info.billing.currency)
      const ok = await p.confirm({
        message: `${integration}/${endpoint} costs ${cost} ${billingUnit(info.billing.model)}, billed to your account. Continue?`,
      })
      if (p.isCancel(ok) || !ok) {
        p.cancel('Cancelled — no call made.')
        // Declining a paid call is a success, not a refusal: nothing was
        // billed and there is nothing to retry.
        return { data: { cancelled: true, integration, endpoint } }
      }
    }
  }

  let jwt: string
  try {
    jwt = await ensureToken()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Refusal(msg, 'not_authenticated', {
      action: cliAction('deepspace', 'auth', 'login'),
    })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()

  let res: Response
  try {
    res = await fetch(`${API_URL}/api/integrations/${integration}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body,
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Refusal(`Request timed out after ${timeoutMs}ms`, 'request_timeout')
    }
    throw new Refusal(err instanceof Error ? err.message : 'Request failed', 'request_failed')
  } finally {
    clearTimeout(timer)
  }

  const elapsed = Date.now() - startedAt
  let payload: Record<string, unknown>
  try {
    payload = (await res.json()) as Record<string, unknown>
  } catch {
    throw new Refusal(`Request failed (${res.status}) with non-JSON response`, 'invalid_response')
  }

  const ok = payload?.success !== false && res.ok
  if (ok) {
    if (!args.json) {
      const data = 'data' in payload ? payload.data : payload
      console.log(JSON.stringify(data, null, 2))
      console.error(`\n✓ ${integration}/${endpoint} (${elapsed}ms)`)
    }
    // The server payload is the machine result, but it is NOT an envelope —
    // hand it to the runtime as `data` so it goes out as `{ ok, …payload }`
    // like every other command instead of passing through unnormalized.
    return { data: payload }
  }

  // Error path. The api-worker's envelope is { error: <machine slug>, message:
  // <human>, ...details } — normalize it once so the human line carries the
  // message (or a humanized slug), never the raw slug. The issue list is part
  // of the message (the human line must carry every fact --json does) and
  // rides along in the envelope via `extra`.
  const norm = normalizeApiError(res.status, payload)
  // No `✗` prefix: the runtime renders the failure marker, and it would read
  // as `■ ✗ …` (and land in the `--json` `error` string) if we kept ours.
  const lines = [`${integration}/${endpoint} (${res.status}, ${elapsed}ms): ${norm.error}`]
  if (norm.issues) {
    for (const issue of norm.issues) {
      const path = issue.path?.length ? issue.path.join('.') : '(root)'
      lines.push(`  - ${path}: ${issue.message}`)
    }
  }
  // The server's own slug (the envelope's `error` field) so an agent branches
  // on the same code the API returns; fall back to a stable generic one.
  const code = norm.code ?? 'integration_call_failed'
  // `error`/`message` would only restate the code + human line the runtime
  // already renders.
  const rest = { ...payload }
  delete rest.error
  delete rest.message
  delete rest.code
  throw new Refusal(lines.join('\n'), code, {
    ...(res.status === 401 ? { action: cliAction('deepspace', 'auth', 'login') } : {}),
    extra: rest,
  })
}
