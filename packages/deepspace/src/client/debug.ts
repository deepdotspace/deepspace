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
