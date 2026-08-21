/**
 * deepspace test screenshot <url> <output> [--full-page] [--viewport WIDTHxHEIGHT]
 *   [--wait-for-timeout ms]
 *
 * Takes a Playwright Chromium screenshot, installing the browser on demand.
 *
 * Playwright is spawned with inherited stdio, so its progress streams straight
 * through — under `--json` that streamed text precedes the envelope, which is
 * still the last line on stdout.
 */

import { sync as spawnSync } from 'cross-spawn'
import { resolve } from 'node:path'
import { ensurePlaywright } from '../lib/playwright'
import { defineDeepspaceCommand, Refusal } from '../lib/command'

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
      description: 'Milliseconds to wait before capture',
      required: false,
    },
  },
  async run({ args }) {
    const viewport = normalizeViewportSize(args.viewport)
    const appDir = resolve('.')
    ensurePlaywright(appDir)

    const url = String(args.url)
    const output = String(args.output)
    const playwrightArgs = ['playwright', 'screenshot', url, output]
    if (args['full-page']) playwrightArgs.push('--full-page')
    if (viewport) playwrightArgs.push('--viewport-size', viewport)
    if (args['wait-for-timeout'] !== undefined) {
      playwrightArgs.push('--wait-for-timeout', String(args['wait-for-timeout']))
    }

    const result = spawnSync('npx', playwrightArgs, {
      cwd: appDir,
      stdio: 'inherit',
    })

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
      data: { url, output, fullPage: Boolean(args['full-page']), viewport: viewport ?? null },
    }
  },
})
