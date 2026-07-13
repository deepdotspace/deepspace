/**
 * captureScreenshot — call platform-worker /internal/screenshot.
 *
 * Apps don't ship CF Browser Rendering bindings or puppeteer in their
 * own bundle. The platform holds the binding; consumers call this
 * helper to get PNG bytes for a URL.
 *
 * The platform enforces: a host allowlist (*.app.space / *.deep.space),
 * a per-app sliding rate limit, and viewport/timeout clamping. Returns
 * `null` on any non-2xx — callers should treat as "no preview available"
 * and surface their own fallback UX.
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

export interface ScreenshotOptions {
  url: string
  viewport?: { width: number; height: number }
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
  timeoutMs?: number
  fullPage?: boolean
}

export interface ScreenshotEnv extends PlatformWorkerEnv {
  /** Immutable app id — the identity the platform verifies (HMAC input). */
  DEEPSPACE_APP_ID: string
  /** Absent until the app's first deploy registers it — see appendAppIdentity. */
  APP_IDENTITY_TOKEN?: string
}

export interface ScreenshotResult {
  /** PNG bytes. */
  body: ArrayBuffer
  /** `image/png`. */
  contentType: string
}

/**
 * Capture a screenshot of `opts.url` and return the PNG bytes.
 *
 * Returns null on capture failure (target unreachable, timeout, BR
 * binding misconfigured platform-side). The platform endpoint logs the
 * underlying error; callers should treat null as "no preview available"
 * and surface their own UX fallback.
 */
export async function captureScreenshot(
  env: ScreenshotEnv,
  opts: ScreenshotOptions,
): Promise<ScreenshotResult | null> {
  const headers = new Headers({ 'content-type': 'application/json' })
  appendAppIdentity(headers, env)

  const res = await platformWorkerFetch(
    env,
    new Request('https://platform-internal/internal/screenshot', {
      method: 'POST',
      headers,
      body: JSON.stringify(opts),
    }),
  )

  if (!res.ok) {
    let detail = ''
    try { detail = (await res.text()).slice(0, 300) } catch { /* ignore */ }
    console.warn(`[captureScreenshot] platform returned ${res.status}:`, detail)
    return null
  }

  return {
    body: await res.arrayBuffer(),
    contentType: res.headers.get('content-type') || 'image/png',
  }
}
