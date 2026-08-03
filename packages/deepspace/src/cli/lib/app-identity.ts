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
import { InputError } from './cli-errors'

// Single source: the shared registry client owns the id shape. Import-then-
// re-export (not a bare `export from`) because line ~151 uses it locally too.
import { APP_ID_RE, LEGACY_APP_ID_RE } from '../../server/utils/registry-client'
export { APP_ID_RE }

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A 26-char ULID (48-bit ms timestamp + 80 random bits, Crockford base32) —
 *  the id shape shared by app ids (`app_…`) and workspace ids (`ws_…`). */
export function mintUlid(now = Date.now()): string {
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
  return `${ts}${rs}`.slice(0, 26)
}

/** Mint a fresh app id: `app_` + 26-char ULID. */
export function mintAppId(now = Date.now()): string {
  return `app_${mintUlid(now)}`
}

interface WranglerVars {
  name?: unknown
  vars?: Record<string, unknown>
  env?: Record<string, { name?: unknown; vars?: Record<string, unknown> }>
}

function readWranglerConfig(cwd: string): WranglerVars | null {
  const wranglerPath = join(resolve(cwd), 'wrangler.toml')
  if (!existsSync(wranglerPath)) return null
  try {
    return parseToml(readFileSync(wranglerPath, 'utf-8')) as WranglerVars
  } catch (err) {
    throw new InputError(
      `Could not parse ${wranglerPath}: ${err instanceof Error ? err.message : String(err)}`,
      'invalid_config',
    )
  }
}

/** Read DEEPSPACE_APP_ID for the given wrangler env (top-level when omitted).
 *  Env blocks do NOT inherit the top-level id — each env is its own app. */
export function readAppId(cwd: string = process.cwd(), wranglerEnv?: string): string | null {
  const cfg = readWranglerConfig(cwd)
  if (!cfg) return null
  const vars = wranglerEnv ? cfg.env?.[wranglerEnv]?.vars : cfg.vars
  const id = vars?.DEEPSPACE_APP_ID
  return typeof id === 'string' && APP_ID_RE.test(id) ? id : null
}

/**
 * Resolve a pre-app-id checkout. Old templates identified an app with both
 * the Worker `name` and `[vars].APP_NAME`; require those values to agree so a
 * migration never guesses which historical registry row to re-key.
 */
export function readLegacyAppId(cwd: string = process.cwd(), wranglerEnv?: string): string | null {
  const cfg = readWranglerConfig(cwd)
  if (!cfg) return null
  const slot = wranglerEnv ? cfg.env?.[wranglerEnv] : cfg
  if (!slot) return null
  const declaredId = slot.vars?.DEEPSPACE_APP_ID
  if (declaredId !== undefined) {
    if (typeof declaredId === 'string' && LEGACY_APP_ID_RE.test(declaredId)) return declaredId
    throw new InputError(
      'DEEPSPACE_APP_ID is present but invalid; correct it before migrating.',
      'invalid_app_id',
    )
  }
  const appName = typeof slot.vars?.APP_NAME === 'string' ? slot.vars.APP_NAME : null
  const workerName = typeof slot.name === 'string' ? slot.name : null
  // APP_NAME was the independent identity declaration in pre-id templates.
  // A plain Worker config with only `name` is merely uninitialized, not proof
  // that a legacy registry row exists.
  if (!appName) return null
  if (!workerName) {
    throw new InputError(
      'Legacy migration requires both Worker name and APP_NAME to be present and identical.',
      'ambiguous_legacy_app_id',
    )
  }
  if (appName !== workerName) {
    throw new InputError(
      `Legacy APP_NAME "${appName}" does not match Worker name "${workerName}"; migration cannot choose safely.`,
      'ambiguous_legacy_app_id',
    )
  }
  const legacyAppId = appName
  if (!legacyAppId || !LEGACY_APP_ID_RE.test(legacyAppId) || APP_ID_RE.test(legacyAppId)) {
    return null
  }
  return legacyAppId
}

/**
 * Write DEEPSPACE_APP_ID into wrangler.toml, text-preserving: appended to the
 * existing `[vars]` / `[env.<name>.vars]` block, or the block is created.
 * Refuses to overwrite an existing id unless `force` — identity is immutable;
 * a new id means a new app (`deepspace app init --new-id`).
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
    const newBlock = idLineRe.test(block) ? block.replace(idLineRe, line) : `\n${line}${block}`
    src = src.slice(0, blockStart) + newBlock + src.slice(blockEnd)
  } else {
    src = src.trimEnd() + `\n\n${header}\n${line}\n`
  }
  writeFileSync(wranglerPath, src)
}
