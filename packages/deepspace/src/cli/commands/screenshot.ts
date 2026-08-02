/**
 * deepspace test screenshot <url> <output> [--full-page] [--wait-for-timeout ms]
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
    'wait-for-timeout': {
      type: 'string',
      description: 'Milliseconds to wait before capture',
      required: false,
    },
  },
  async run({ args }) {
    const appDir = resolve('.')
    ensurePlaywright(appDir)

    const url = String(args.url)
    const output = String(args.output)
    const playwrightArgs = ['playwright', 'screenshot', url, output]
    if (args['full-page']) playwrightArgs.push('--full-page')
    if (args['wait-for-timeout']) {
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

    return { data: { url, output, fullPage: Boolean(args['full-page']) } }
  },
})
