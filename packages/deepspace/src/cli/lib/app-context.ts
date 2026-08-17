/** Discover the local DeepSpace app surrounding a working directory. */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { readWranglerConfig } from './wrangler-env'

/** Read the app name from the local wrangler.toml, when present. A broken
 *  file surfaces as the shared reader's `WranglerConfigError`. */
export function detectAppName(cwd: string = process.cwd()): string | null {
  const appDir = resolve(cwd)
  if (!existsSync(join(appDir, 'wrangler.toml'))) return null
  const { name } = readWranglerConfig(appDir)
  return typeof name === 'string' && name.length > 0 ? name : null
}

/** Walk upward to the nearest directory containing wrangler.toml. */
export function findAppDir(start: string = process.cwd()): string | null {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, 'wrangler.toml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Immediate child directories that contain wrangler.toml. */
export function findChildApps(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'wrangler.toml')))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}
