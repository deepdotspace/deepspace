/**
 * deepspace domain — purchase and manage custom domains for your apps.
 *
 * Designed to be both human-friendly and agent/script-friendly:
 *   - All destructive commands accept `--yes` to skip prompts.
 *   - All read commands accept `--json` for structured stdout.
 *   - `--app` defaults to the cwd's wrangler.toml name (matches `deepspace deploy`).
 *   - `domain buy` opens Stripe Checkout in a browser and polls until live;
 *     pass `--no-open` to print the URL only, `--no-wait` to skip polling.
 *
 * Subcommands:
 *   search <query>            — find available domains and prices
 *   buy <domain>              — buy a domain via Stripe Checkout (browser)
 *   list                      — list domains you own
 *   status <domain>           — detail view for one domain
 *   attach <domain>           — re-point a domain at a different app
 *   detach <domain>           — stop routing the domain (keeps registration)
 *   renew <domain> --auto X   — toggle auto-renew on/off at the registrar
 */

import { defineCommand } from 'citty'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { apiFetch } from '../lib/api'
import { openBrowser } from '../lib/open-browser'
import { requireAppName, detectAppName } from '../lib/app-context'

const API_URL = process.env.DEEPSPACE_API_URL ?? PLATFORM_URLS.api

interface SearchResult {
  name: string
  registrable: boolean
  registrar?: 'cloudflare' | 'namesilo'
  pricing?: { currency: string; registrationCost: string; renewalCost: string }
  registrationCost?: number
  renewalCost?: number
  chargedCents?: number | null
  costCents?: number | null
  reason?: string
  premium?: boolean
}

interface DomainPurchase {
  id: string
  domain: string
  appName: string
  status: string
  statusError?: string | null
  registeredAt?: string | null
  expiresAt?: string | null
  chargedCents: number
  autoRenew: boolean
  registrar: string
}

const api = <T>(token: string, path: string, init?: RequestInit): Promise<T> =>
  apiFetch<T>(API_URL, token, path, init)

/**
 * Strip internal-only pricing fields from any value before emitting it to
 * stdout. The api-worker exposes both the user-facing `chargedCents` and the
 * platform's at-cost `costCents`; only the former should reach the CLI user.
 */
function scrubInternal<T>(value: T): T {
  if (Array.isArray(value)) return value.map(scrubInternal) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'costCents') continue
      out[k] = scrubInternal(v)
    }
    return out as T
  }
  return value
}

function fmtCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return `$${(cents / 100).toFixed(2)}`
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return iso.slice(0, 10)
}

/**
 * Plain stdin Y/N prompt — no clack, agent can pipe `yes` or pass --yes.
 */
async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Non-interactive (piped, agent) — refuse rather than hang
    throw new Error(`${message} — pass --yes to confirm non-interactively`)
  }
  process.stdout.write(`${message} [y/N] `)
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf-8')
    process.stdin.once('data', (data) => {
      const answer = data.toString().trim().toLowerCase()
      resolve(answer === 'y' || answer === 'yes')
    })
  })
}

// ============================================================================
// search
// ============================================================================

const search = defineCommand({
  meta: { name: 'search', description: 'Search for available domains' },
  args: {
    query: { type: 'positional', description: 'Domain or keyword', required: true },
    limit: { type: 'string', description: 'Max results (default 10)', default: '10' },
    json: { type: 'boolean', description: 'Emit JSON instead of a table' },
  },
  async run({ args }) {
    const token = await ensureToken()
    const limit = parseInt(args.limit ?? '10', 10) || 10
    const result = await api<{ domains: SearchResult[] }>(
      token,
      `/api/domains/search?q=${encodeURIComponent(args.query)}&limit=${limit}`,
    )
    if (args.json) {
      process.stdout.write(JSON.stringify(scrubInternal(result), null, 2) + '\n')
      return
    }
    if (result.domains.length === 0) {
      console.log('No matches.')
      return
    }
    for (const d of result.domains) {
      const tag = d.registrable ? '✓' : '✗'
      const price = d.registrable ? `${fmtCents(d.chargedCents)}/yr` : (d.reason ?? '—')
      // Annotate slow-path TLDs so users have realistic expectations.
      const slowFlag =
        d.registrar && d.registrar !== 'cloudflare' ? '  (15-60 min provisioning)' : ''
      console.log(`${tag} ${d.name.padEnd(40)} ${price}${slowFlag}`)
    }
  },
})

// ============================================================================
// buy
// ============================================================================

const buy = defineCommand({
  meta: { name: 'buy', description: 'Buy a domain and attach it to an app' },
  args: {
    domain: { type: 'positional', description: 'Domain to buy', required: true },
    app: { type: 'string', description: 'App to attach (defaults to ./wrangler.toml)' },
    yes: { type: 'boolean', description: 'Skip the confirmation prompt', default: false },
    open: {
      type: 'boolean',
      description: 'Open browser at Stripe URL (use --no-open to print URL only)',
      default: true,
    },
    wait: {
      type: 'boolean',
      description:
        'Poll until provisioning completes (use --no-wait to exit after session creation)',
      default: true,
    },
    json: { type: 'boolean', description: 'Emit JSON to stdout', default: false },
  },
  async run({ args }) {
    const token = await ensureToken()
    const appName = requireAppName(args.app)

    // Re-check pricing
    const priceCheck = await api<{ domains: SearchResult[] }>(token, '/api/domains/check', {
      method: 'POST',
      body: JSON.stringify({ domains: [args.domain] }),
    })
    const result = priceCheck.domains[0]
    if (!result || !result.registrable) {
      console.error(`Not available: ${result?.reason ?? 'unknown'}`)
      process.exit(1)
    }

    const price = fmtCents(result.chargedCents)
    // Provisioning time depends on registrar:
    //   CF Registrar (.com/.dev/.app/.xyz/etc): ~60-90s — registry publishes
    //     CF nameservers atomically with registration.
    //   Porkbun fallback (.ai/.io/.me/.co/etc + ccTLDs): 15-60 min — depends
    //     on the destination registry (Verisign/.me, NIC.AI, etc) batch-
    //     publishing our NS records to public DNS. The platform side is
    //     done in <30s; the wait is registry-side.
    const expectedTime =
      result.registrar === 'cloudflare'
        ? '~60-90 seconds'
        : '15-60 minutes (registry NS propagation)'

    if (!args.yes) {
      const ok = await confirm(
        `Buy ${args.domain} for ${price}/yr (auto-renews; non-refundable), attach to ${appName}? Provisioning takes ${expectedTime}.`,
      )
      if (!ok) {
        console.log('Cancelled.')
        return
      }
    }

    const checkout = await api<{
      purchaseId: string
      sessionId: string
      url: string
      chargedCents: number
    }>(token, '/api/domains/checkout', {
      method: 'POST',
      body: JSON.stringify({ domain: args.domain, appId: appName }),
    })

    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          scrubInternal({ ...checkout, expectedTime, registrar: result.registrar }),
          null,
          2,
        ) + '\n',
      )
    } else {
      console.log(`Stripe Checkout: ${checkout.url}`)
    }

    if (args.open && process.stdin.isTTY) {
      openBrowser(checkout.url)
    }

    if (!args.wait) return

    // Poll until active or failed.
    // Timeout depends on registrar — CF can take 5 min worst case, Porkbun
    // up to 60 min for slow registries. User can Ctrl-C and resume polling
    // later via `deepspace domain status <domain>` — provisioning runs
    // server-side regardless.
    const timeoutMs = result.registrar === 'cloudflare' ? 5 * 60 * 1000 : 60 * 60 * 1000
    if (!args.json) {
      console.log(
        `Waiting for payment & provisioning (up to ${expectedTime}). Press Ctrl-C anytime —`,
      )
      console.log(
        `provisioning continues server-side; check later with \`deepspace domain status ${args.domain}\`.`,
      )
    }
    const deadline = Date.now() + timeoutMs
    let lastStatus = ''
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000))
      try {
        const detail = await api<{ domain: DomainPurchase }>(
          token,
          `/api/domains/${checkout.purchaseId}`,
        )
        if (detail.domain.status !== lastStatus) {
          lastStatus = detail.domain.status
          if (!args.json) console.log(`  → ${lastStatus}`)
        }
        if (detail.domain.status === 'active') {
          if (args.json) {
            process.stdout.write(
              JSON.stringify(
                scrubInternal({ ...checkout, status: 'active', domain: args.domain }),
                null,
                2,
              ) + '\n',
            )
          } else {
            console.log(`✓ ${args.domain} is live and pointing at ${appName}`)
          }
          return
        }
        if (detail.domain.status.startsWith('failed:')) {
          console.error(`Provisioning failed: ${detail.domain.statusError ?? detail.domain.status}`)
          process.exit(1)
        }
      } catch (err) {
        // Transient — keep polling
        if (!args.json)
          console.error(`(poll error: ${err instanceof Error ? err.message : String(err)})`)
      }
    }
    console.error(`Polling timed out. Provisioning may still be in progress; check with:`)
    console.error(`  deepspace domain status ${args.domain}`)
    process.exit(1)
  },
})

// ============================================================================
// list
// ============================================================================

const list = defineCommand({
  meta: { name: 'list', description: 'List your domains' },
  args: {
    json: { type: 'boolean', description: 'Emit JSON' },
  },
  async run({ args }) {
    const token = await ensureToken()
    const result = await api<{ domains: DomainPurchase[] }>(token, '/api/domains')
    if (args.json) {
      process.stdout.write(JSON.stringify(scrubInternal(result), null, 2) + '\n')
      return
    }
    if (result.domains.length === 0) {
      console.log('No domains. Try `deepspace domain search <name>`.')
      return
    }
    console.log(
      `DOMAIN                              APP                  STATUS               EXPIRES      AUTO-RENEW`,
    )
    for (const d of result.domains) {
      console.log(
        `${d.domain.padEnd(35)} ${d.appName.padEnd(20)} ${d.status.padEnd(20)} ${fmtDate(d.expiresAt).padEnd(12)} ${d.autoRenew ? 'on' : 'off'}`,
      )
    }
  },
})

// ============================================================================
// status
// ============================================================================

const status = defineCommand({
  meta: { name: 'status', description: 'Show details for one domain' },
  args: {
    domain: { type: 'positional', description: 'Domain', required: true },
    json: { type: 'boolean' },
  },
  async run({ args }) {
    const token = await ensureToken()
    const all = await api<{ domains: DomainPurchase[] }>(token, '/api/domains')
    const found = all.domains.find((d) => d.domain === args.domain)
    if (!found) {
      console.error(`No domain ${args.domain} in your account`)
      process.exit(1)
    }
    if (args.json) {
      process.stdout.write(JSON.stringify(scrubInternal(found), null, 2) + '\n')
      return
    }
    console.log(`Domain:        ${found.domain}`)
    console.log(
      `Status:        ${found.status}${found.statusError ? ` (${found.statusError})` : ''}`,
    )
    console.log(`Attached app:  ${found.appName}`)
    console.log(`Registrar:     ${found.registrar}`)
    console.log(`Registered:    ${fmtDate(found.registeredAt)}`)
    console.log(`Expires:       ${fmtDate(found.expiresAt)}`)
    console.log(`Auto-renew:    ${found.autoRenew ? 'on' : 'off'}`)
    console.log(`Charged:       ${fmtCents(found.chargedCents)}/yr`)
  },
})

// ============================================================================
// attach
// ============================================================================

const attach = defineCommand({
  meta: { name: 'attach', description: 'Re-point a domain at a different app' },
  args: {
    domain: { type: 'positional', description: 'Domain to re-point', required: true },
    app: { type: 'string', description: 'Target app (defaults to ./wrangler.toml)' },
    json: { type: 'boolean' },
  },
  async run({ args }) {
    const token = await ensureToken()
    const targetApp = requireAppName(args.app)
    const all = await api<{ domains: DomainPurchase[] }>(token, '/api/domains')
    const found = all.domains.find((d) => d.domain === args.domain)
    if (!found) {
      console.error(`No domain ${args.domain} in your account`)
      process.exit(1)
    }
    const result = await api<{ success: boolean; appName: string }>(
      token,
      `/api/domains/${found.id}/reattach`,
      {
        method: 'POST',
        body: JSON.stringify({ appId: targetApp }),
      },
    )
    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      return
    }
    console.log(`✓ ${args.domain} now points at ${targetApp}`)
  },
})

// ============================================================================
// detach
// ============================================================================

const detach = defineCommand({
  meta: {
    name: 'detach',
    description: 'Stop routing the domain (keeps the registration; auto-renew unchanged)',
  },
  args: {
    domain: { type: 'positional', description: 'Domain to detach', required: true },
    yes: { type: 'boolean', description: 'Skip the confirmation prompt' },
  },
  async run({ args }) {
    const token = await ensureToken()
    const all = await api<{ domains: DomainPurchase[] }>(token, '/api/domains')
    const found = all.domains.find((d) => d.domain === args.domain)
    if (!found) {
      console.error(`No domain ${args.domain} in your account`)
      process.exit(1)
    }
    if (!args.yes) {
      const ok = await confirm(
        `Detach ${args.domain}? Routing will stop; the domain stays registered (auto-renew is unchanged).`,
      )
      if (!ok) {
        console.log('Cancelled.')
        return
      }
    }
    await api(token, `/api/domains/${found.id}`, { method: 'DELETE' })
    console.log(
      `✓ ${args.domain} detached. Use \`deepspace domain attach\` to re-route, or \`renew --auto off\` to stop auto-renewal.`,
    )
  },
})

// ============================================================================
// renew
// ============================================================================

const renew = defineCommand({
  meta: { name: 'renew', description: 'Toggle auto-renewal at the registrar' },
  args: {
    domain: { type: 'positional', description: 'Domain', required: true },
    auto: { type: 'string', description: '"on" or "off"', required: true },
  },
  async run({ args }) {
    if (args.auto !== 'on' && args.auto !== 'off') {
      console.error('--auto must be "on" or "off"')
      process.exit(1)
    }
    const token = await ensureToken()
    const all = await api<{ domains: DomainPurchase[] }>(token, '/api/domains')
    const found = all.domains.find((d) => d.domain === args.domain)
    if (!found) {
      console.error(`No domain ${args.domain} in your account`)
      process.exit(1)
    }
    const enabled = args.auto === 'on'
    await api(token, `/api/domains/${found.id}/auto-renew`, {
      method: 'POST',
      body: JSON.stringify({ autoRenew: enabled }),
    })
    console.log(`✓ ${args.domain} auto-renew ${enabled ? 'enabled' : 'disabled'}`)
  },
})

// ============================================================================
// Top-level
// ============================================================================

// Note: no `run()` on the parent — citty otherwise calls it after every
// subcommand finishes, which prints spurious help text.
//
// `detectAppName` is imported for type-checking the `--app` defaulting in
// each subcommand; not used here directly.
void detectAppName

export default defineCommand({
  meta: { name: 'domain', description: 'Buy and manage custom domains' },
  subCommands: { search, buy, list, status, attach, detach, renew },
})
