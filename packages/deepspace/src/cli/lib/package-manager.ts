import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

function declaredPackageManager(appDir: string): PackageManager | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8')) as {
      packageManager?: unknown
    }
    const name = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : ''
    if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return name
  } catch {
    // Missing/malformed package.json falls through to lockfile detection.
  }
  return undefined
}

/** Resolve the repository's package manager from its explicit packageManager
 * field first, then its lockfile. npm is the conservative fallback. */
export function detectPackageManager(appDir: string): PackageManager {
  const declared = declaredPackageManager(appDir)
  if (declared) return declared
  if (existsSync(join(appDir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(appDir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(appDir, 'bun.lock')) || existsSync(join(appDir, 'bun.lockb'))) return 'bun'
  return 'npm'
}

export function installCommand(appDir: string): string {
  return `${detectPackageManager(appDir)} install`
}

/** A recovered checkout should reproduce its committed dependency graph. */
export function recoveryInstallArgv(appDir: string): string[] | undefined {
  // Raw Worker projects can be cloned and deployed without a package manager.
  if (!existsSync(join(appDir, 'package.json'))) return undefined
  // Without a declared manager, a committed npm lockfile outranks other
  // lockfiles that a recovered checkout may carry stale.
  const npmLock =
    existsSync(join(appDir, 'npm-shrinkwrap.json')) || existsSync(join(appDir, 'package-lock.json'))
  const manager = declaredPackageManager(appDir) ?? (npmLock ? 'npm' : detectPackageManager(appDir))
  if (manager === 'npm') return ['npm', npmLock ? 'ci' : 'install']
  if (manager === 'pnpm')
    return [
      'pnpm',
      'install',
      ...(existsSync(join(appDir, 'pnpm-lock.yaml')) ? ['--frozen-lockfile'] : []),
    ]
  if (manager === 'bun')
    return [
      'bun',
      'install',
      ...(existsSync(join(appDir, 'bun.lock')) || existsSync(join(appDir, 'bun.lockb'))
        ? ['--frozen-lockfile']
        : []),
    ]
  if (!existsSync(join(appDir, 'yarn.lock'))) return ['yarn', 'install']
  // Yarn Classic and Berry use different reproducibility flags. The lockfile
  // format is authoritative even when packageManager is not recorded.
  const classic = /^# yarn lockfile v1\s*$/m.test(readFileSync(join(appDir, 'yarn.lock'), 'utf8'))
  return ['yarn', 'install', classic ? '--frozen-lockfile' : '--immutable']
}
