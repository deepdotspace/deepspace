/**
 * App identity (docs/proposals/app-identity-registry.md).
 *
 * Every app carries an immutable id in wrangler.toml:
 *
 *   [vars]
 *   DEEPSPACE_APP_ID = "app_01JG8QK…"      # minted at scaffold/init
 *
 *   [env.staging.vars]
 *   DEEPSPACE_APP_ID = "app_01JG8QM…"      # each env is its own app
 *
 * The wrangler `name` field is just the subdomain label the next deploy
 * claims; identity is the id. Minting is local (a ULID — 80 random bits
 * need no server round-trip to be unique); registration happens at first
 * deploy.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'

export const APP_ID_RE = /^(app_[0-9A-HJKMNP-TV-Z]{26}|[a-z0-9][a-z0-9_-]{0,63})$/

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Mint a fresh app id: `app_` + 26-char ULID (48-bit ms timestamp + 80
 *  random bits, Crockford base32). */
export function mintAppId(now = Date.now()): string {
  let ts = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t % 32] + ts
    t = Math.floor(t / 32)
  }
  const rand = new Uint8Array(10)
  crypto.getRandomValues(rand)
  let rs = ''
  let acc = 0
  let bits = 0
  for (const byte of rand) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      rs += CROCKFORD[(acc >> bits) & 31]
    }
  }
  return `app_${ts}${rs}`.slice(0, 30)
}

/**
 * Adopt the caller's existing app id for this subdomain, if they already own an
 * app there. A repo with no `DEEPSPACE_APP_ID` must NOT blindly mint a fresh id:
 * an app the platform already registered — e.g. one backfilled during the
 * app-identity cutover — owns its route, so a fresh id would collide
 * ("name … is taken by another app"). Look up the caller's apps and reuse the
 * id for a matching subdomain; return null (→ mint a new one) only when they
 * own nothing here. Best-effort: any failure returns null so the deploy still
 * proceeds and mints, exactly as before.
 */
export async function resolveOwnedAppId(
  deployUrl: string,
  token: string,
  appName: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${deployUrl}/api/apps`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const body = (await res.json()) as {
      apps?: Array<{ appId?: string; name?: string | null }>
    }
    const match = body.apps?.find((a) => a.name === appName)
    return match?.appId ?? null
  } catch {
    return null
  }
}

interface WranglerVars {
  vars?: Record<string, unknown>
  env?: Record<string, { vars?: Record<string, unknown> }>
}

/** Read DEEPSPACE_APP_ID for the given wrangler env (top-level when omitted).
 *  Env blocks do NOT inherit the top-level id — each env is its own app. */
export function readAppId(cwd: string = process.cwd(), wranglerEnv?: string): string | null {
  const wranglerPath = join(resolve(cwd), 'wrangler.toml')
  if (!existsSync(wranglerPath)) return null
  let cfg: WranglerVars
  try {
    cfg = parseToml(readFileSync(wranglerPath, 'utf-8')) as WranglerVars
  } catch (err) {
    // A corrupt wrangler.toml must NOT read as "no id yet" — callers would
    // tell the user to run `deepspace init` (a lie) or mint a SECOND id
    // into the broken file. Surface the real problem.
    throw new Error(
      `Could not parse ${wranglerPath}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const vars = wranglerEnv ? cfg.env?.[wranglerEnv]?.vars : cfg.vars
  const id = vars?.DEEPSPACE_APP_ID
  return typeof id === 'string' && APP_ID_RE.test(id) ? id : null
}

/**
 * Write DEEPSPACE_APP_ID into wrangler.toml, text-preserving: appended to the
 * existing `[vars]` / `[env.<name>.vars]` block, or the block is created.
 * Refuses to overwrite an existing id unless `force` — identity is immutable;
 * a new id means a new app (`deepspace init --new-id`).
 */
export function writeAppId(
  cwd: string,
  appId: string,
  opts: { wranglerEnv?: string; force?: boolean } = {},
): void {
  const wranglerPath = join(resolve(cwd), 'wrangler.toml')
  if (!existsSync(wranglerPath)) {
    throw new Error(`No wrangler.toml in ${resolve(cwd)}`)
  }
  const existing = readAppId(cwd, opts.wranglerEnv)
  if (existing && !opts.force) {
    if (existing === appId) return
    throw new Error(
      `wrangler.toml already carries ${existing}. The app id is immutable — use --new-id only to fork this repo as a separate app.`,
    )
  }

  let src = readFileSync(wranglerPath, 'utf-8')
  const header = opts.wranglerEnv ? `[env.${opts.wranglerEnv}.vars]` : '[vars]'
  const line = `DEEPSPACE_APP_ID = "${appId}"`
  const headerRe = new RegExp(`^\\${header.replace(/\./g, '\\.')}[ \\t]*$`, 'm')
  const idLineRe = /^DEEPSPACE_APP_ID\s*=.*$/m

  const match = headerRe.exec(src)
  if (match) {
    // Insert (or replace) inside the existing block: from the header to the
    // next section header or EOF.
    const blockStart = match.index + match[0].length
    const rest = src.slice(blockStart)
    const nextSection = rest.search(/^\s*\[/m)
    const blockEnd = nextSection === -1 ? src.length : blockStart + nextSection
    const block = src.slice(blockStart, blockEnd)
    const newBlock = idLineRe.test(block)
      ? block.replace(idLineRe, line)
      : `\n${line}${block}`
    src = src.slice(0, blockStart) + newBlock + src.slice(blockEnd)
  } else {
    src = src.trimEnd() + `\n\n${header}\n${line}\n`
  }
  writeFileSync(wranglerPath, src)
}

/** Read the app id or fail with the actionable next step. */
export function requireAppId(cwd: string = process.cwd(), wranglerEnv?: string): string {
  const id = readAppId(cwd, wranglerEnv)
  if (id) return id
  const where = wranglerEnv ? `[env.${wranglerEnv}.vars]` : '[vars]'
  throw new Error(
    `wrangler.toml has no DEEPSPACE_APP_ID in ${where}. Run \`deepspace init\` to mint one (existing deployed apps get theirs from the migration backfill — see the app-identity runbook).`,
  )
}
