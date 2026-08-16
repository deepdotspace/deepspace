/**
 * captureScreenshot — call platform-worker /internal/screenshot.
 *
 * Apps don't ship CF Browser Rendering bindings or puppeteer in their
 * own bundle. The platform holds the binding; consumers call this
 * helper to get PNG bytes for a URL.
 *
 * The platform enforces HTTPS, a DeepSpace host allowlist, a per-app rate
 * limit, and one fixed viewport-only capture profile. Returns `null` on any
 * non-2xx — callers should treat that as "no preview available".
 *
 * Auth is the same HMAC-of-appId pattern `/internal/files` uses:
 *   x-app-identity-token = hmac(PLATFORM_IDENTITY_SECRET, DEEPSPACE_APP_ID)
 *   x-app-id             = DEEPSPACE_APP_ID
 *
 * Apps already have both as bindings (APP_IDENTITY_TOKEN + DEEPSPACE_APP_ID),
 * so this helper is a thin wrapper — no extra secrets to manage.
 */
import { platformWorkerFetch, type PlatformWorkerEnv } from './proxies'
import { appendAppIdentity } from './app-identity'

export interface ScreenshotEnv extends PlatformWorkerEnv {
  /** Immutable app id — the identity the platform verifies (HMAC input). */
  DEEPSPACE_APP_ID: string
  /** Absent until the app's first deploy injects it — see appendAppIdentity. */
  APP_IDENTITY_TOKEN?: string
}

export interface ScreenshotResult {
  /** PNG bytes. */
  body: ArrayBuffer
  /** `image/png`. */
  contentType: string
}

/**
 * Capture a screenshot of `url` and return the PNG bytes.
 *
 * Returns null on capture failure (target unreachable, timeout, BR
 * binding misconfigured platform-side). The platform logs a generic failure
 * without target details; callers should surface their own fallback UX.
 */
export async function captureScreenshot(
  env: ScreenshotEnv,
  url: string,
): Promise<ScreenshotResult | null> {
  const headers = new Headers({ 'content-type': 'application/json' })
  appendAppIdentity(headers, env)

  const res = await platformWorkerFetch(
    env,
    new Request('https://platform-internal/internal/screenshot', {
      method: 'POST',
      headers,
      body: JSON.stringify({ url }),
    }),
  )

  if (!res.ok) {
    console.warn(`[captureScreenshot] platform returned ${res.status}`)
    return null
  }

  return {
    body: await res.arrayBuffer(),
    contentType: res.headers.get('content-type') || 'image/png',
  }
}
