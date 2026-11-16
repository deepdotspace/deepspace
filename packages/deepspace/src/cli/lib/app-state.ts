import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { keepLocalPathIgnored } from './git/repository'

/**
 * The app's local CLI state directory, `.deepspace/`: deploy and register
 * locks, install sentinels, test output and process hooks. Created on demand
 * and kept out of Git, because deploy refuses a dirty worktree before it ships.
 */
export function appStateDir(appDir: string): string {
  const dir = join(appDir, '.deepspace')
  mkdirSync(dir, { recursive: true })
  keepLocalPathIgnored(appDir, '.deepspace')
  return dir
}
