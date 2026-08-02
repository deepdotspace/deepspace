import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

/** Resolve the repository's package manager from its explicit packageManager
 * field first, then its lockfile. npm is the conservative fallback. */
export function detectPackageManager(appDir: string): PackageManager {
  try {
    const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8')) as {
      packageManager?: unknown
    }
    const name = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : ''
    if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return name
  } catch {
    // Missing/malformed package.json falls through to lockfile detection.
  }
  if (existsSync(join(appDir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(appDir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(appDir, 'bun.lock')) || existsSync(join(appDir, 'bun.lockb'))) return 'bun'
  return 'npm'
}

export function installCommand(appDir: string): string {
  return `${detectPackageManager(appDir)} install`
}
