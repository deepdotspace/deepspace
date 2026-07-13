/**
 * Shared implementation for `deepspace invoke` and `deepspace integrations *`.
 *
 * The CLI invokes platform integrations as the currently logged-in user
 * (the same identity shown by `deepspace whoami`). That user is billed.
 *
 * This module is the single source of truth for:
 *   - listing the integration catalog
 *   - showing per-endpoint info (schema + example body)
 *   - making the actual POST call
 *
 * Both `commands/invoke.ts` (top-level alias) and `commands/integrations.ts`
 * (namespaced subcommands) delegate here so the behavior never drifts.
 *
 * Why `flushAndExit` is used (only on the --json paths):
 * Large JSON outputs (the full catalog is ~78KB) exceed the OS pipe buffer,
 * and libuv flushes piped writes asynchronously — a plain `process.exit()`
 * would truncate stdout for any downstream consumer that JSON.parses it
 * (jq, file redirects, agent scripts, the e2e tests). So on the --json
 * paths we wait for stdout to drain before exiting. See flushAndExit().
 *
 * Human-mode paths don't need this: they return / process.exit() normally.
 */

import { readFileSync } from 'node:fs'
import * as p from '@clack/prompts'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'

const API_URL = process.env.DEEPSPACE_API_URL ?? PLATFORM_URLS.api
const DEFAULT_TIMEOUT_MS = 120_000

interface EndpointInfo {
  endpoint: string
  billing: { model: string; baseCost: number; currency: string }
  inputSchema: Record<string, unknown> | null
  example: Record<string, unknown> | null
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
    throw new Error(
      "Missing target. Expected '<integration>/<endpoint>' (e.g. 'openai/chat-completion').",
    )
  }
  const parts = target.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Bad target '${target}'. Expected '<integration>/<endpoint>' (e.g. 'openai/chat-completion').`,
    )
  }
  return { integration: parts[0], endpoint: parts[1] }
}

/**
 * Resolve the request body from --body, --body-file, or default to '{}'.
 * Errors if both --body and --body-file are provided, or the body isn't
 * valid JSON.
 */
function resolveBody(opts: { body?: string; bodyFile?: string }): string {
  if (opts.body != null && opts.bodyFile != null) {
    throw new Error('Pass either --body or --body-file, not both.')
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
    throw new Error(`Body is not valid JSON: ${msg}`)
  }
  return raw
}

/**
 * Exit the process after stdout has drained.
 *
 * Used only on --json paths. Plain `process.exit()` truncates piped stdout
 * for outputs larger than the pipe buffer (~64KB on macOS) —
 * `integrations --json | jq` would lose data because libuv flushes
 * asynchronously.
 *
 * The pattern: schedule a zero-byte write so its callback fires only
 * after all prior writes have been flushed, then exit from the callback.
 * Returns a Promise that never resolves so the caller can `await` it.
 */
function flushAndExit(code: number): Promise<never> {
  return new Promise<never>(() => {
    process.stdout.write('', () => process.exit(code))
  })
}

async function fetchCatalog(opts: { summary?: boolean } = {}): Promise<Catalog> {
  // `list` uses the summary view (names + billing); the full catalog with every
  // endpoint's schema is large enough to be truncated in an agent's terminal.
  // `info` omits the flag so it still gets the schema + example.
  const url = opts.summary ? `${API_URL}/api/integrations?summary=1` : `${API_URL}/api/integrations`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch integration catalog (${res.status})`)
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
 * `deepspace integrations` (default action) / `--list`
 * Prints the catalog grouped by integration.
 */
export async function runList(args: ListArgs): Promise<void> {
  const catalog = await fetchCatalog({ summary: true })

  if (args.json) {
    process.stdout.write(JSON.stringify(catalog) + '\n')
    await flushAndExit(0)
  }

  const names = Object.keys(catalog.integrations).sort()
  if (names.length === 0) {
    console.log('No integrations available.')
    return
  }

  for (const name of names) {
    console.log(name)
    const endpoints = [...catalog.integrations[name]].sort((a, b) =>
      a.endpoint.localeCompare(b.endpoint),
    )
    const widest = Math.max(...endpoints.map((e) => e.endpoint.length))
    for (const ep of endpoints) {
      const pad = ep.endpoint.padEnd(widest)
      const cost = formatCurrency(ep.billing.baseCost, ep.billing.currency)
      console.log(`  ${pad}  ${ep.billing.model.padEnd(12)} ${cost}`)
    }
    console.log()
  }

  console.log("Run 'deepspace integrations info <integration>/<endpoint>' for the request schema.")
}

/**
 * `deepspace integrations info <target>` / `--info`
 * Prints the schema + example body for a single endpoint.
 */
export async function runInfo(args: InfoArgs): Promise<void> {
  const { integration, endpoint } = parseTarget(args.target)
  const catalog = await fetchCatalog()
  const info = findEndpoint(catalog, integration, endpoint)

  if (!info) {
    const available = catalog.integrations[integration]
    if (!available) {
      const names = Object.keys(catalog.integrations).sort().join(', ')
      throw new Error(`Unknown integration '${integration}'. Available: ${names}`)
    }
    const endpoints = available.map((e) => e.endpoint).join(', ')
    throw new Error(`Unknown endpoint '${endpoint}' for '${integration}'. Available: ${endpoints}`)
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(info) + '\n')
    await flushAndExit(0)
  }

  console.log(`${integration}/${endpoint}`)
  console.log(
    `  billing: ${formatCurrency(info.billing.baseCost, info.billing.currency)} ${billingUnit(info.billing.model)}`,
  )
  console.log()
  console.log('Input schema:')
  console.log(
    info.inputSchema ? JSON.stringify(info.inputSchema, null, 2) : '  (no schema registered)',
  )
  console.log()
  console.log('Example body:')
  console.log(info.example ? JSON.stringify(info.example, null, 2) : '  (no example available)')
}

/**
 * `deepspace invoke <target>` / `deepspace integrations invoke <target>`
 * Performs the actual integration call.
 */
export async function runInvoke(args: InvokeArgs): Promise<void> {
  const { integration, endpoint } = parseTarget(args.target)
  const body = resolveBody({ body: args.body, bodyFile: args.bodyFile })
  const timeoutMs = args.timeout ?? DEFAULT_TIMEOUT_MS

  // FEAT-13: this fires a PAID call billed to the logged-in user. On a fully
  // interactive terminal, confirm the cost first (unless --yes or --json).
  // Gate on BOTH streams: p.confirm reads stdin and draws to stdout, so a piped
  // stdin (e.g. `echo {} | deepspace invoke … --body-file -`) must never reach
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
        process.exit(0)
      }
    }
  }

  let jwt: string
  try {
    jwt = await ensureToken()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(msg)
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
      throw new Error(`Request timed out after ${timeoutMs}ms`)
    }
    throw new Error(err instanceof Error ? err.message : 'Request failed')
  } finally {
    clearTimeout(timer)
  }

  const elapsed = Date.now() - startedAt
  let payload: Record<string, unknown>
  try {
    payload = (await res.json()) as Record<string, unknown>
  } catch {
    throw new Error(`Request failed (${res.status}) with non-JSON response`)
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(payload) + '\n')
    await flushAndExit(payload?.success === false || !res.ok ? 1 : 0)
  }

  const ok = payload?.success !== false && res.ok
  if (ok) {
    const data = 'data' in payload ? payload.data : payload
    console.log(JSON.stringify(data, null, 2))
    console.error(`\n✓ ${integration}/${endpoint} (${elapsed}ms)`)
    return
  }

  // Error path
  const errMsg = (payload.error as string) ?? `Request failed (${res.status})`
  console.error(`✗ ${integration}/${endpoint} (${res.status}, ${elapsed}ms): ${errMsg}`)
  if (Array.isArray(payload.issues)) {
    for (const issue of payload.issues as Array<{ path?: string[]; message: string }>) {
      const path = issue.path?.length ? issue.path.join('.') : '(root)'
      console.error(`  - ${path}: ${issue.message}`)
    }
  }
  if (res.status === 401) {
    console.error("\nHint: run 'deepspace login' to authenticate.")
  }
  process.exit(1)
}
