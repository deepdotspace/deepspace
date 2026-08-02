/**
 * deepspace app domain — purchase and manage custom domains for your apps.
 *
 * Designed to be both human-friendly and agent/script-friendly:
 *   - All destructive commands accept `--yes` to skip prompts.
 *   - `--json` (injected by the command runtime) gives every subcommand a
 *     single-line `{ ok, … }` document on stdout.
 *   - `--app` accepts an app id or live name and defaults to the cwd's app id.
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
 *
 * Defined with the command runtime (lib/command.ts). Two deviations fixed
 * here: `buy --json` used to emit TWO JSON documents (the checkout session,
 * then the provisioning outcome), and the confirmation prompts in `buy` and
 * `detach` would hang a `--json` caller. See each subcommand.
 */

import { defineCommand } from 'citty'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { apiFetch } from '../lib/api'
import { openBrowser } from '../lib/open-browser'
import { resolveAppTarget } from '../lib/app-target'
import { cliAction, defineDeepspaceCommand, Refusal } from '../lib/command'

const API_URL = process.env.DEEPSPACE_API_URL ?? PLATFORM_URLS.api
const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

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
  appId: string
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
 * Plain stdin Y/N prompt — no clack. Only ever reached on the interactive
 * human path: callers refuse with `confirmation_required` when there is no
 * TTY or `--json` is set, so a prompt can never hang a machine caller.
 */
async function confirm(message: string): Promise<boolean> {
  process.stdout.write(`${message} [y/N] `)
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf-8')
    process.stdin.once('data', (data) => {
      const answer = data.toString().trim().toLowerCase()
      resolve(answer === 'y' || answer === 'yes')
    })
  })
}

/** True when asking a question would hang the caller (agent, pipe, `--json`). */
const cannotPrompt = (json: boolean): boolean => json || !process.stdin.isTTY

// ============================================================================
// search
// ============================================================================

const search = defineDeepspaceCommand({
  meta: { name: 'search', description: 'Search for available domains' },
  args: {
    query: { type: 'positional', description: 'Domain or keyword', required: true },
    limit: { type: 'string', description: 'Max results (default 10)', default: '10' },
  },
  async run({ args }) {
    const token = await ensureToken()
    const limit = parseInt(String(args.limit ?? '10'), 10) || 10
    const result = await api<{ domains: SearchResult[] }>(
      token,
      `/api/domains/search?q=${encodeURIComponent(String(args.query))}&limit=${limit}`,
    )
    const scrubbed = scrubInternal(result)
    if (!args.json) {
      if (result.domains.length === 0) {
        console.log('No matches.')
      } else {
        for (const d of result.domains) {
          const tag = d.registrable ? '✓' : '✗'
          const price = d.registrable ? `${fmtCents(d.chargedCents)}/yr` : (d.reason ?? '—')
          // Annotate slow-path TLDs so users have realistic expectations.
          const slowFlag =
            d.registrar && d.registrar !== 'cloudflare' ? '  (15-60 min provisioning)' : ''
          console.log(`${tag} ${d.name.padEnd(40)} ${price}${slowFlag}`)
        }
      }
    }
    return { data: { domains: scrubbed.domains } }
  },
})

// ============================================================================
// buy
// ============================================================================

const buy = defineDeepspaceCommand({
  meta: { name: 'buy', description: 'Buy a domain and attach it to an app' },
  args: {
    domain: { type: 'positional', description: 'Domain to buy', required: true },
    app: { type: 'string', description: 'App id or live name (defaults to ./wrangler.toml)' },
    yes: { type: 'boolean', description: 'Skip the confirmation prompt', default: false },
    open: {
      type: 'boolean',
      description: 'Open browser at Stripe URL (use --no-open to print URL only)',
      default: true,
    },
    wait: {
      type: 'boolean',
      description:
        'Poll until provisioning completes (use --no-wait to exit after session creation). ' +
        'Implicitly off under --json, whose single document is the checkout session.',
      default: true,
    },
  },
  async run({ args }) {
    const domain = String(args.domain)
    const token = await ensureToken()
    const appId = await resolveAppTarget(DEPLOY_URL, token, args.app as string | undefined)

    // Re-check pricing
    const priceCheck = await api<{ domains: SearchResult[] }>(token, '/api/domains/check', {
      method: 'POST',
      body: JSON.stringify({ domains: [domain] }),
    })
    const result = priceCheck.domains[0]
    if (!result || !result.registrable) {
      throw new Refusal(`Not available: ${result?.reason ?? 'unknown'}`, 'domain_not_available', {
        action: cliAction('deepspace', 'app', 'domain', 'search', domain),
      })
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
      // A purchase is irreversible, so it must be confirmed — but a prompt
      // would hang an agent or a `--json` caller. Refuse and name the flag.
      if (cannotPrompt(args.json)) {
        throw new Refusal(
          `Buying ${domain} for ${price}/yr (auto-renews; non-refundable) and attaching it to ` +
            `${appId} needs confirmation. Provisioning takes ${expectedTime}. Re-run with --yes.`,
          'confirmation_required',
        )
      }
      const ok = await confirm(
        `Buy ${domain} for ${price}/yr (auto-renews; non-refundable), attach to ${appId}? Provisioning takes ${expectedTime}.`,
      )
      if (!ok) {
        console.log('Cancelled.')
        return { data: { domain, cancelled: true } }
      }
    }

    const checkout = await api<{
      purchaseId: string
      sessionId: string
      url: string
      chargedCents: number
    }>(token, '/api/domains/checkout', {
      method: 'POST',
      body: JSON.stringify({ domain, appId }),
    })

    if (!args.json) console.log(`Stripe Checkout: ${checkout.url}`)

    if (args.open && process.stdin.isTTY) {
      openBrowser(checkout.url)
    }

    // ONE document under --json. The checkout URL is the actionable outcome
    // and the caller needs it NOW (it has to be paid before provisioning even
    // starts) — so `--json` never polls; it returns the session and points at
    // `domain status` for the result. The human path keeps the live progress.
    if (!args.wait || args.json) {
      return {
        data: scrubInternal({ ...checkout, expectedTime, registrar: result.registrar, domain }),
        action: cliAction('deepspace', 'app', 'domain', 'status', domain),
      }
    }

    // Poll until active or failed.
    // Timeout depends on registrar — CF can take 5 min worst case, Porkbun
    // up to 60 min for slow registries. User can Ctrl-C and resume polling
    // later via `deepspace app domain status <domain>` — provisioning runs
    // server-side regardless.
    const timeoutMs = result.registrar === 'cloudflare' ? 5 * 60 * 1000 : 60 * 60 * 1000
    console.log(
      `Waiting for payment & provisioning (up to ${expectedTime}). Press Ctrl-C anytime —`,
    )
    console.log(
      `provisioning continues server-side; check later with \`deepspace app domain status ${domain}\`.`,
    )
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
          console.log(`  → ${lastStatus}`)
        }
        if (detail.domain.status === 'active') {
          console.log(`✓ ${domain} is live and pointing at ${appId}`)
          return {
            data: scrubInternal({ ...checkout, status: 'active', domain, appId }),
          }
        }
        if (detail.domain.status.startsWith('failed:')) {
          throw new Refusal(
            `Provisioning failed: ${detail.domain.statusError ?? detail.domain.status}`,
            'provisioning_failed',
            { action: cliAction('deepspace', 'app', 'domain', 'status', domain) },
          )
        }
      } catch (err) {
        if (err instanceof Refusal) throw err
        // Transient — keep polling
        console.error(`(poll error: ${err instanceof Error ? err.message : String(err)})`)
      }
    }
    throw new Refusal(
      `Polling timed out. Provisioning may still be in progress; check with: deepspace app domain status ${domain}`,
      'provisioning_timeout',
      { action: cliAction('deepspace', 'app', 'domain', 'status', domain) },
    )
  },
})

// ============================================================================
// list
// ============================================================================

const list = defineDeepspaceCommand({
  meta: { name: 'list', description: 'List your domains' },
  async run({ args }) {
    const token = await ensureToken()
    const result = await api<{ domains: DomainPurchase[] }>(token, '/api/domains')
    const scrubbed = scrubInternal(result)
    if (result.domains.length === 0) {
      if (!args.json) console.log('No domains. Try `deepspace app domain search <name>`.')
      return { data: { domains: scrubbed.domains } }
    }
    if (!args.json) {
      console.log(
        `DOMAIN                              APP                  STATUS               EXPIRES      AUTO-RENEW`,
      )
      for (const d of result.domains) {
        console.log(
          `${d.domain.padEnd(35)} ${d.appId.padEnd(20)} ${d.status.padEnd(20)} ${fmtDate(d.expiresAt).padEnd(12)} ${d.autoRenew ? 'on' : 'off'}`,
        )
      }
    }
    return { data: { domains: scrubbed.domains } }
  },
})

// ============================================================================
// status
// ============================================================================

/** The caller's domain, or a coded refusal naming how to list them. */
async function requireDomain(token: string, domain: string): Promise<DomainPurchase> {
  const all = await api<{ domains: DomainPurchase[] }>(token, '/api/domains')
  const found = all.domains.find((d) => d.domain === domain)
  if (!found) {
    throw new Refusal(`No domain ${domain} in your account`, 'domain_not_found', {
      action: cliAction('deepspace', 'app', 'domain', 'list'),
    })
  }
  return found
}

const status = defineDeepspaceCommand({
  meta: { name: 'status', description: 'Show details for one domain' },
  args: {
    domain: { type: 'positional', description: 'Domain', required: true },
  },
  async run({ args }) {
    const token = await ensureToken()
    const found = await requireDomain(token, String(args.domain))
    if (!args.json) {
      console.log(`Domain:        ${found.domain}`)
      console.log(
        `Status:        ${found.status}${found.statusError ? ` (${found.statusError})` : ''}`,
      )
      console.log(`Attached app:  ${found.appId}`)
      console.log(`Registrar:     ${found.registrar}`)
      console.log(`Registered:    ${fmtDate(found.registeredAt)}`)
      console.log(`Expires:       ${fmtDate(found.expiresAt)}`)
      console.log(`Auto-renew:    ${found.autoRenew ? 'on' : 'off'}`)
      console.log(`Charged:       ${fmtCents(found.chargedCents)}/yr`)
    }
    return { data: scrubInternal({ ...found }) }
  },
})

// ============================================================================
// attach
// ============================================================================

const attach = defineDeepspaceCommand({
  meta: { name: 'attach', description: 'Re-point a domain at a different app' },
  args: {
    domain: { type: 'positional', description: 'Domain to re-point', required: true },
    app: { type: 'string', description: 'Target app id or live name (defaults to ./wrangler.toml)' },
  },
  async run({ args }) {
    const domain = String(args.domain)
    const token = await ensureToken()
    const targetAppId = await resolveAppTarget(
      DEPLOY_URL,
      token,
      args.app as string | undefined,
    )
    const found = await requireDomain(token, domain)
    const result = await api<{ success: boolean; appId: string }>(
      token,
      `/api/domains/${found.id}/reattach`,
      {
        method: 'POST',
        body: JSON.stringify({ appId: targetAppId }),
      },
    )
    if (!args.json) console.log(`✓ ${domain} now points at ${targetAppId}`)
    // `success` is dropped: the envelope's `ok` already carries it.
    return { data: { domain, appId: result.appId } }
  },
})

// ============================================================================
// detach
// ============================================================================

const detach = defineDeepspaceCommand({
  meta: {
    name: 'detach',
    description: 'Stop routing the domain (keeps the registration; auto-renew unchanged)',
  },
  args: {
    domain: { type: 'positional', description: 'Domain to detach', required: true },
    yes: { type: 'boolean', description: 'Skip the confirmation prompt' },
  },
  async run({ args }) {
    const domain = String(args.domain)
    const token = await ensureToken()
    const found = await requireDomain(token, domain)
    if (!args.yes) {
      if (cannotPrompt(args.json)) {
        throw new Refusal(
          `Detaching ${domain} stops routing (the domain stays registered; auto-renew is ` +
            'unchanged) and needs confirmation. Re-run with --yes.',
          'confirmation_required',
        )
      }
      const ok = await confirm(
        `Detach ${domain}? Routing will stop; the domain stays registered (auto-renew is unchanged).`,
      )
      if (!ok) {
        console.log('Cancelled.')
        return { data: { domain, cancelled: true } }
      }
    }
    await api(token, `/api/domains/${found.id}`, { method: 'DELETE' })
    if (!args.json) {
      console.log(
        `✓ ${domain} detached. Use \`deepspace app domain attach\` to re-route, or \`renew --auto off\` to stop auto-renewal.`,
      )
    }
    return { data: { domain, detached: true } }
  },
})

// ============================================================================
// renew
// ============================================================================

const renew = defineDeepspaceCommand({
  meta: { name: 'renew', description: 'Toggle auto-renewal at the registrar' },
  args: {
    domain: { type: 'positional', description: 'Domain', required: true },
    auto: { type: 'string', description: '"on" or "off"', required: true },
  },
  async run({ args }) {
    const domain = String(args.domain)
    if (args.auto !== 'on' && args.auto !== 'off') {
      throw new Refusal('--auto must be "on" or "off"', 'invalid_auto')
    }
    const token = await ensureToken()
    const found = await requireDomain(token, domain)
    const enabled = args.auto === 'on'
    await api(token, `/api/domains/${found.id}/auto-renew`, {
      method: 'POST',
      body: JSON.stringify({ autoRenew: enabled }),
    })
    if (!args.json) console.log(`✓ ${domain} auto-renew ${enabled ? 'enabled' : 'disabled'}`)
    // Terminal toggle: nothing follows.
    return { data: { domain, autoRenew: enabled } }
  },
})

// ============================================================================
// Top-level
// ============================================================================

// Note: no `run()` on the parent — citty otherwise calls it after every
// subcommand finishes, which prints spurious help text.
//
export default defineCommand({
  meta: { name: 'domain', description: 'Buy and manage custom domains' },
  subCommands: { search, buy, list, status, attach, detach, renew },
})
