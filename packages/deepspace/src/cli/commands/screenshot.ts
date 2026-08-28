/**
 * deepspace test screenshot <url> <output> [--full-page] [--viewport WIDTHxHEIGHT]
 *   [--wait-for-selector selector] [--wait-for-timeout ms]
 *
 * Takes a Playwright Chromium screenshot, installing the browser on demand.
 *
 * By default the command waits one short render settle after load, avoiding
 * blank first-paint captures. `--wait-for-selector` is opt-in: a default
 * selector would hang the capture on exactly the broken pages (crashed SPA,
 * hidden-first-child layouts) a screenshot exists to diagnose.
 */

import { sync as spawnSync } from 'cross-spawn'
import { resolve } from 'node:path'
import { childStdio, ensurePlaywright, routeChildStdoutToStderr } from '../lib/playwright'
import { defineDeepspaceCommand, Refusal } from '../lib/command'

export const DEFAULT_SCREENSHOT_WAIT_MS = 1000

export function normalizeWaitTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_SCREENSHOT_WAIT_MS
  const text = String(value).trim()
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Refusal(
      'Screenshot wait timeout must be a non-negative whole number of milliseconds.',
      'invalid_wait_timeout',
    )
  }
  return Number(text)
}

export function normalizeViewportSize(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const match = /^(\d+)\s*[x,]\s*(\d+)$/i.exec(String(value).trim())
  const width = Number(match?.[1] ?? Number.NaN)
  const height = Number(match?.[2] ?? Number.NaN)
  if (
    !match ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Refusal(
      'Viewport must be positive WIDTHxHEIGHT dimensions, for example 390x844.',
      'invalid_viewport',
    )
  }
  return `${width},${height}`
}

export default defineDeepspaceCommand({
  meta: {
    name: 'screenshot',
    description: 'Take a Playwright screenshot, installing Chromium on demand',
  },
  args: {
    url: {
      type: 'positional',
      description: 'URL to capture, for example http://localhost:5173/',
      required: true,
    },
    output: {
      type: 'positional',
      description: 'Output image path, for example screenshot.png',
      required: true,
    },
    'full-page': {
      type: 'boolean',
      description: 'Capture the full scrollable page',
      required: false,
    },
    viewport: {
      type: 'string',
      description: 'Browser viewport as WIDTHxHEIGHT, for example 390x844',
      required: false,
    },
    'wait-for-timeout': {
      type: 'string',
      description: `Milliseconds to settle before capture (default ${DEFAULT_SCREENSHOT_WAIT_MS}, 0 disables)`,
      required: false,
    },
    'wait-for-selector': {
      type: 'string',
      description: 'Visible selector to await before capture (off by default)',
      required: false,
    },
  },
  async run({ args }) {
    routeChildStdoutToStderr(args.json === true)
    const viewport = normalizeViewportSize(args.viewport)
    const waitForTimeout = normalizeWaitTimeout(args['wait-for-timeout'])
    const appDir = resolve('.')
    ensurePlaywright(appDir)

    const url = String(args.url)
    const output = String(args.output)
    const playwrightArgs = ['playwright', 'screenshot', url, output]
    const waitForSelector =
      args['wait-for-selector'] === undefined ? '' : String(args['wait-for-selector'])
    if (args['full-page']) playwrightArgs.push('--full-page')
    if (viewport) playwrightArgs.push('--viewport-size', viewport)
    if (waitForSelector) playwrightArgs.push('--wait-for-selector', waitForSelector)
    if (waitForTimeout !== 0) playwrightArgs.push('--wait-for-timeout', String(waitForTimeout))

    // Wall-bounded: playwright's own --wait-for-selector wait is UNBOUNDED
    // (the r2 AX pass sat >90s, twice, with no output) — a capture must
    // surface a missing selector as a fast failure, never a stall. The bound
    // is the caller's own wait budget plus generous launch/paint headroom.
    const wallMs = (waitForTimeout || 0) + 60_000
    const result = spawnSync('npx', playwrightArgs, {
      cwd: appDir,
      stdio: childStdio(),
      timeout: wallMs,
    })

    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Refusal(
        `Screenshot timed out after ${Math.round(wallMs / 1000)}s` +
          (waitForSelector
            ? ` waiting for \`${waitForSelector}\` to become visible — the selector never matched. Check it against the live page, or drop --wait-for-selector to capture the page as it is.`
            : '.'),
        'screenshot_timeout',
      )
    }
    // Playwright already printed the reason; the refusal adds the slug an
    // agent branches on. Its own exit code collapses to 1 — the contract
    // reserves 0/1/2, and playwright only ever means "failed" here.
    if (result.status !== 0) {
      throw new Refusal(
        `Screenshot failed: playwright exited ${result.status ?? 'without a status'}.`,
        'screenshot_failed',
      )
    }

    return {
      data: {
        url,
        output,
        fullPage: Boolean(args['full-page']),
        viewport: viewport ?? null,
        waitForSelector: waitForSelector || null,
        waitForTimeout,
      },
    }
  },
})
