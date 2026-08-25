/**
 * App identity (docs/proposals/app-identity-registry.md).
 *
 * Every app carries an immutable id in wrangler.toml:
 *
 *   [vars]
 *   DEEPSPACE_APP_ID = "app_01JG8QK…"      # server-minted at `app init`
 *
 *   [env.staging.vars]
 *   DEEPSPACE_APP_ID = "app_01JG8QM…"      # each env is its own app
 *
 * The wrangler `name` field is just the subdomain label the next deploy
 * claims; identity is the id. Ids are minted by the deploy worker's
 * authenticated `POST /api/apps/mint` — registered to the caller the moment
 * they exist — so this module only reads and writes them; it never invents
 * one.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  hasWranglerConfig,
  readAppIdVar,
  readWranglerConfig,
  WranglerConfigError,
  type WranglerConfig,
} from './wrangler-env'

// Single source: the shared registry client owns the id shape. Import-then-
// re-export (not a bare `export from`) because readAppId uses it locally too.
import { APP_ID_RE } from '../../server/utils/registry-client'
export { APP_ID_RE }

/**
 * EVERY app id this checkout declares — top-level and every `[env.<name>]`.
 *
 * A wrangler env is a separate app, and they share one working tree. Anything
 * asking "does this checkout own that app?" has to consider all of them:
 * comparing against the top-level id alone makes `deploy --env staging`
 * structurally impossible, with advice ("run from that app's own checkout")
 * that cannot be followed because the env has no separate checkout.
 *
 * Empty set when there is no readable config — callers read that as "cannot
 * prove a mismatch", never as "mismatch".
 */
export function declaredAppIds(cwd: string = process.cwd()): Set<string> {
  const appDir = resolve(cwd)
  if (!hasWranglerConfig(appDir)) return new Set()
  let cfg: WranglerConfig
  try {
    cfg = readWranglerConfig(appDir)
  } catch {
    // A half-edited wrangler.toml is not evidence of anything.
    return new Set()
  }
  const sections = [cfg.vars, ...Object.values(cfg.env ?? {}).map((env) => env?.vars)]
  return new Set(
    sections
      .map((vars) => vars?.DEEPSPACE_APP_ID)
      .filter((id): id is string => typeof id === 'string' && APP_ID_RE.test(id)),
  )
}

/** The value a fresh scaffold carries until `deepspace app init` registers it. */
export const APP_ID_PLACEHOLDER = '__APP_ID__'

/**
 * Read DEEPSPACE_APP_ID for the given wrangler env (top-level when omitted).
 *
 * `null` means ABSENT: no app here, no `DEEPSPACE_APP_ID` in the section, or
 * the scaffold's `__APP_ID__` placeholder — the states `deepspace app init`
 * heals. A value that is present but is not an app id THROWS (`invalid_app_id`)
 * instead: ids are server-minted, so a malformed one was hand-edited or
 * corrupted, and reporting it as "no id" sent every command's recovery
 * (`app init`) off to mint a fresh id over the top of it — orphaning the app
 * the directory belonged to and burning a quota slot. A wrangler.toml that is
 * unreadable, malformed TOML, or gives one id to two sections throws
 * `WranglerConfigError` from the shared reader in the same way.
 */
export function readAppId(cwd: string = process.cwd(), wranglerEnv?: string): string | null {
  const appDir = resolve(cwd)
  if (!hasWranglerConfig(appDir)) return null
  const id = readAppIdVar(readWranglerConfig(appDir), wranglerEnv)
  if (id === undefined || id === APP_ID_PLACEHOLDER) return null
  if (typeof id === 'string' && APP_ID_RE.test(id)) return id
  const section = wranglerEnv ? `[env.${wranglerEnv}.vars]` : '[vars]'
  throw new WranglerConfigError(
    join(appDir, 'wrangler.toml'),
    `wrangler.toml: ${section} DEEPSPACE_APP_ID = ${JSON.stringify(id)} is not an app id ` +
      `(expected app_ followed by 26 characters). Ids are server-minted at \`deepspace app init\` ` +
      `and never hand-written — restore the id this app was registered under (\`deepspace app list\` ` +
      `shows your apps' ids), or run \`deepspace app init --new-id\` to register this directory as a ` +
      `separate app (new data, secrets, and registration).`,
    'invalid_app_id',
  )
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
  // `force` (--new-id) replaces whatever is there — a registered id or a
  // malformed value alike; only an unforced write reads what it would overwrite.
  if (!opts.force) {
    const existing = readAppId(cwd, opts.wranglerEnv)
    if (existing === appId) return
    if (existing) {
      throw new Error(
        `wrangler.toml already carries ${existing}. The app id is immutable — use --new-id only to fork this repo as a separate app.`,
      )
    }
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
