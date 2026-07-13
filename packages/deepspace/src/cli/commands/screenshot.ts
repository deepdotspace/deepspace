/**
 * deepspace screenshot <url> <output> [--full-page] [--wait-for-timeout ms]
 *
 * Takes a Playwright Chromium screenshot, installing the browser on demand.
 */

import { defineCommand } from 'citty'
import { sync as spawnSync } from 'cross-spawn'
import { resolve } from 'node:path'
import { ensurePlaywright } from '../lib/playwright'

export default defineCommand({
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
  run({ args }) {
    const appDir = resolve('.')
    ensurePlaywright(appDir)

    const playwrightArgs = ['playwright', 'screenshot', args.url, args.output]
    if (args['full-page']) playwrightArgs.push('--full-page')
    if (args['wait-for-timeout']) {
      playwrightArgs.push('--wait-for-timeout', String(args['wait-for-timeout']))
    }

    const result = spawnSync('npx', playwrightArgs, {
      cwd: appDir,
      stdio: 'inherit',
    })

    process.exit(result.status ?? 1)
  },
})
