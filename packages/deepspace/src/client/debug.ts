/**
 * Debug gate for the client SDK.
 *
 * The SDK's connection/auth/Yjs logs are useful when developing an app but
 * shouldn't spam every consuming app's production console. They're silent by
 * default and opt-in via either:
 *   - `localStorage.DEEPSPACE_DEBUG = '1'` (browser, persists across reloads), or
 *   - `globalThis.DEEPSPACE_DEBUG = true` (set before the SDK loads).
 *
 * Read once at module load so the gate is a cheap boolean check per call.
 */
function readDebugFlag(): boolean {
  try {
    const g = globalThis as { DEEPSPACE_DEBUG?: unknown; localStorage?: Storage }
    if (g.DEEPSPACE_DEBUG === true || g.DEEPSPACE_DEBUG === '1') return true
    const ls = g.localStorage?.getItem('DEEPSPACE_DEBUG')
    return ls === '1' || ls === 'true'
  } catch {
    // localStorage can throw (e.g. sandboxed iframes) — treat as disabled.
    return false
  }
}

export const DEBUG = readDebugFlag()

/** console.log gated behind the DEEPSPACE_DEBUG flag. No-op by default. */
export function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log(...args)
}

/**
 * True when the page is served from a local dev host (`deepspace dev` binds
 * localhost). Gates developer-facing diagnostics that must never render for
 * real visitors on a deployed app. Hostname-based rather than a build-time
 * env because the SDK is prebuilt — it can't see the consuming app's
 * NODE_ENV or import.meta.env. Named for the hostname check to keep it
 * distinct from `isLocalDev` in shared/env, which answers a different
 * question (which platform environment to talk to) from different signals.
 *
 * Explicit override: set `globalThis.DEEPSPACE_DEV = true` to force the
 * diagnostics on (LAN preview, tunnels), or `= false` to force them off
 * (e.g. a consumer's jsdom test setup, where `location.hostname` defaults
 * to localhost). Mirrors the DEEPSPACE_DEBUG pattern above.
 */
export function isLocalDevHost(): boolean {
  try {
    const g = globalThis as { DEEPSPACE_DEV?: unknown; location?: Location }
    // Accept the string/number spellings too — someone typing 'false' and
    // getting diagnostics anyway is the exact opposite of their intent.
    if (
      g.DEEPSPACE_DEV === true ||
      g.DEEPSPACE_DEV === '1' ||
      g.DEEPSPACE_DEV === 'true' ||
      g.DEEPSPACE_DEV === 1
    )
      return true
    if (
      g.DEEPSPACE_DEV === false ||
      g.DEEPSPACE_DEV === '0' ||
      g.DEEPSPACE_DEV === 'false' ||
      g.DEEPSPACE_DEV === 0
    )
      return false
    const host = g.location?.hostname
    if (!host) return false
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host.endsWith('.localhost')
    )
  } catch {
    return false
  }
}
