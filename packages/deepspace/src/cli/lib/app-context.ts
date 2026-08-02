/** Discover the local DeepSpace app surrounding a working directory. */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { InputError } from './cli-errors'

/** Read the app name from the local wrangler.toml, when present. */
export function detectAppName(cwd: string = process.cwd()): string | null {
  const wranglerPath = join(resolve(cwd), 'wrangler.toml')
  if (!existsSync(wranglerPath)) return null
  try {
    const config = parseToml(readFileSync(wranglerPath, 'utf-8')) as { name?: string }
    return typeof config.name === 'string' && config.name.length > 0 ? config.name : null
  } catch (error) {
    throw new InputError(
      `Could not parse ${wranglerPath}: ${error instanceof Error ? error.message : String(error)}`,
      'invalid_config',
    )
  }
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
