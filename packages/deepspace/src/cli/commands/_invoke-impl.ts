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
import { ensureToken, loginAction } from '../auth'
import { PLATFORM_URLS } from '../env'
import { ApiError, fetchIntegrationCatalog } from '../lib/api'
import { cliAction, Refusal, type CommandResult } from '../lib/command'
import { normalizeApiError } from '../../shared/api-error'
import { readStreamText } from '../lib/stdio'

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
  billing: { model: string; baseCost: number | null; currency: string; variesWithInput?: true }
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
async function resolveBody(opts: { body?: string; bodyFile?: string }): Promise<string> {
  if (opts.body != null && opts.bodyFile != null) {
    throw new Refusal('Pass either --body or --body-file, not both.', 'conflicting_body_args')
  }

  let raw: string
  if (opts.body != null) {
    raw = opts.body
  } else if (opts.bodyFile != null) {
    if (opts.bodyFile === '-' && process.stdin.isTTY) {
      throw new Refusal(
        'Reading the body from stdin ("-"), but stdin is a terminal — pipe JSON in, or pass --body / a file path.',
        'no_stdin',
      )
    }
    raw =
      opts.bodyFile === '-'
        ? await readStreamText(process.stdin)
        : readFileSync(opts.bodyFile, 'utf-8')
    if (opts.bodyFile === '-' && raw.trim() === '') {
      throw new Refusal(
        'Nothing arrived on stdin — check the command feeding this one, or pass --body / a file path.',
        'empty_input',
      )
    }
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
  try {
    return await fetchIntegrationCatalog<Catalog>(API_URL, { summary: opts.summary })
  } catch (err) {
    if (err instanceof ApiError) throw new Refusal(err.message, err.code ?? 'catalog_unavailable')
    throw err
  }
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
 * The one price sentence — list, info, and the consent prompt all say the
 * same thing. The catalog is honest about the two cases one number does not
 * cover: a metered endpoint (`baseCost: null`) is billed at the provider's
 * actual cost after the call, and an endpoint whose multipliers depend on
 * the input names its 1x reference rate without pretending it is a floor.
 */
export function priceLabel(billing: EndpointInfo['billing']): string {
  if (billing.baseCost === null) return "metered at the provider's actual cost"
  const figure = `${formatCurrency(billing.baseCost, billing.currency)} ${billingUnit(billing.model)}`
  return billing.variesWithInput ? `base ${figure} (some inputs cost less or more)` : figure
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
export function isInteractive(stdin: { isTTY?: boolean }, stdout: { isTTY?: boolean }): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY)
}

/**
 * What stands between `invoke` and a PAID call (FEAT-13). `--yes` is the one
 * pre-approval; a free endpoint needs none. Otherwise a person at an
 * interactive terminal is asked (default No); every other caller — piped,
 * CI, or `--json` (an agent) — is refused with the price and told to pass
 * `--yes`, so nothing is ever billed silently. Pure for testing.
 */
export function costGate(opts: {
  json: boolean
  interactive: boolean
  /** Catalog price; `null` = metered (billed after the call) — paid until proven free. */
  baseCost: number | null
}): 'proceed' | 'confirm' | 'refuse' {
  if (opts.baseCost === 0) return 'proceed'
  return opts.interactive && !opts.json ? 'confirm' : 'refuse'
}

/**
 * The example body `info` prints. The catalog's own example when it names a
 * field; otherwise one synthesized from the input schema's `required` keys,
 * so the body an agent copies is never `{}` for an endpoint that rejects `{}`.
 * Placeholders come from the schema (`example`, `default`, first `enum`) or
 * the type (`"<string>"`, `0`, `false`, `[]`, `{}`). Null when neither the
 * catalog nor the schema says anything.
 */
export function exampleBody(info: {
  example: Record<string, unknown> | null
  inputSchema: Record<string, unknown> | null
}): Record<string, unknown> | null {
  if (info.example && Object.keys(info.example).length > 0) return info.example
  const required = info.inputSchema?.required
  const properties = info.inputSchema?.properties as Record<string, unknown> | undefined
  if (!Array.isArray(required) || required.length === 0) return info.example
  const body: Record<string, unknown> = {}
  for (const key of required) {
    if (typeof key !== 'string') continue
    const prop = (properties?.[key] ?? {}) as Record<string, unknown>
    body[key] =
      'example' in prop
        ? prop.example
        : 'default' in prop
          ? prop.default
          : Array.isArray(prop.enum) && prop.enum.length
            ? prop.enum[0]
            : (PLACEHOLDER_BY_TYPE[String(prop.type)] ?? '<value>')
  }
  return body
}

const PLACEHOLDER_BY_TYPE: Record<string, unknown> = {
  string: '<string>',
  number: 0,
  integer: 0,
  boolean: false,
  array: [],
  object: {},
}

/**
 * `deepspace integrations list`
 * Prints the catalog grouped by integration.
 */
export async function runList(args: ListArgs): Promise<CommandResult> {
  const catalog = await fetchCatalog({ summary: true })
  // One order for both outputs: integrations by name, endpoints by name.
  const integrations: Catalog['integrations'] = {}
  for (const name of Object.keys(catalog.integrations).sort()) {
    integrations[name] = [...catalog.integrations[name]].sort((a, b) =>
      a.endpoint.localeCompare(b.endpoint),
    )
  }
  const names = Object.keys(integrations)

  if (!args.json) {
    if (names.length === 0) {
      console.log('No integrations available.')
    } else {
      for (const name of names) {
        console.log(name)
        const endpoints = integrations[name]
        const widest = Math.max(...endpoints.map((e) => e.endpoint.length))
        // Two lines per endpoint: key + billing + [oauth] flag, then the
        // description indented below — so the flag is never buried past the
        // terminal width by a long description.
        for (const ep of endpoints) {
          const pad = ep.endpoint.padEnd(widest)
          const oauth = ep.requiresOAuth ? ' [oauth]' : ''
          console.log(`  ${pad}  ${ep.billing.model.padEnd(12)} ${priceLabel(ep.billing)}${oauth}`)
          if (ep.description) console.log(`    ${ep.description}`)
        }
        console.log()
      }
    }
  }

  return { data: { ...catalog, integrations } as unknown as Record<string, unknown> }
}

/**
 * `deepspace integrations info <target>`
 * Prints the schema + example body for a single endpoint.
 */
/** The endpoint's catalog entry, or the one refusal `info` and `invoke` share for a name the catalog does not know. */
function requireEndpoint(catalog: Catalog, integration: string, endpoint: string): EndpointInfo {
  const info = findEndpoint(catalog, integration, endpoint)
  if (info) return info
  const available = catalog.integrations[integration]
  if (!available) {
    const names = Object.keys(catalog.integrations).sort().join(', ')
    throw new Refusal(
      `Unknown integration '${integration}'. Available: ${names}`,
      'unknown_integration',
      {
        action: cliAction('deepspace', 'integrations', 'list'),
      },
    )
  }
  const endpoints = available.map((e) => e.endpoint).join(', ')
  throw new Refusal(
    `Unknown endpoint '${endpoint}' for '${integration}'. Available: ${endpoints}`,
    'unknown_endpoint',
    { action: cliAction('deepspace', 'integrations', 'list') },
  )
}

export async function runInfo(args: InfoArgs): Promise<CommandResult> {
  const { integration, endpoint } = parseTarget(args.target)
  const info = requireEndpoint(await fetchCatalog(), integration, endpoint)

  // Human and --json show the same body (see exampleBody).
  info.example = exampleBody(info)

  if (!args.json) {
    console.log(`${integration}/${endpoint}`)
    if (info.description) console.log(`  ${info.description}`)
    console.log(`  billing: ${priceLabel(info.billing)}`)
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
  const body = await resolveBody({ body: args.body, bodyFile: args.bodyFile })
  const timeoutMs = args.timeout ?? DEFAULT_TIMEOUT_MS

  // FEAT-13: this fires a PAID call billed to the logged-in user. Without
  // `--yes` the price is looked up first (an unknown endpoint is left to the
  // POST, which reports it); a catalog that cannot be read is a refusal from
  // fetchCatalog, never a silent spend. Interactive means BOTH streams are
  // TTYs: p.confirm reads stdin and draws to stdout, so a piped stdin (e.g.
  // `echo {} | … --body-file -`) must never reach the prompt — it would hang.
  if (!args.yes) {
    const info = requireEndpoint(await fetchCatalog({ summary: true }), integration, endpoint)
    const gate = costGate({
      json: !!args.json,
      interactive: isInteractive(process.stdin, process.stdout),
      baseCost: info.billing.baseCost,
    })
    if (gate !== 'proceed') {
      const price = priceLabel(info.billing)
      if (gate === 'refuse') {
        throw new Refusal(
          `${integration}/${endpoint} is billed to your account: ${price}. Pass --yes to confirm the spend (no call was made).`,
          'cost_confirmation_required',
        )
      }
      const ok = await p.confirm({
        message: `${integration}/${endpoint} is billed to your account: ${price}. Continue?`,
        initialValue: false,
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
      action: loginAction(),
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
    ...(res.status === 401 ? { action: loginAction() } : {}),
    extra: rest,
  })
}
