/**
 * deepspace add <feature> [dir]
 *
 * Installs a DeepSpace feature into the current app.
 *
 *   deepspace add --list              # list available features
 *   deepspace add messaging           # install into current dir
 *   deepspace add messaging ./my-app  # install into specific dir
 *   deepspace add --info messaging    # show feature details
 */

import { defineCommand } from 'citty'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { ensureInstallReady } from '../lib/install-status'

function findScript(from: string): string | null {
  // Preferred: ships inside the deepspace npm package at
  // node_modules/deepspace/scripts/add-feature.cjs, so the script and its
  // sibling features/ dir are delivered by `npm install`.
  const inNodeModules = join(from, 'node_modules', 'deepspace', 'scripts', 'add-feature.cjs')
  if (existsSync(inNodeModules)) return inNodeModules
  // Fallback for apps scaffolded before features moved into the SDK; their
  // .deepspace/ folder still works with newer deepspace versions.
  const inDotDeepspace = join(from, '.deepspace', 'scripts', 'add-feature.cjs')
  if (existsSync(inDotDeepspace)) return inDotDeepspace
  return null
}

/**
 * The installer + its sibling features/ dir that ship inside THIS running
 * deepspace package (the bin is dist/cli.js, so `..` is the package root and
 * scripts/ + features/ are its siblings via package.json "files"). Used for
 * catalog queries (--list / --info / help) so they work before the target app
 * has run `npm install`.
 */
function runningScript(): string | null {
  const here = dirname(fileURLToPath(import.meta.url)) // <pkg>/dist
  const script = join(here, '..', 'scripts', 'add-feature.cjs')
  return existsSync(script) ? script : null
}

/**
 * A DeepSpace app has a wrangler.toml (workers config) or declares `deepspace`
 * as a dependency. A bare/unrelated directory has neither — installing a
 * feature there would just scatter files, so we redirect to `deepspace create`.
 */
export function isDeepSpaceApp(dir: string): boolean {
  if (existsSync(join(dir, 'wrangler.toml'))) return true
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return false
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return Boolean(pkg.dependencies?.deepspace || pkg.devDependencies?.deepspace)
  } catch {
    return false
  }
}

/** Run the .cjs installer with inherited stdio and exit with its status. */
function runInstaller(script: string, passArgs: string[], cwd: string): never {
  const res = spawnSync(process.execPath, [script, ...passArgs], { stdio: 'inherit', cwd })
  if (res.error) {
    console.error(`Could not run the feature installer: ${res.error.message}`)
    process.exit(1)
  }
  process.exit(res.status ?? 1)
}

export default defineCommand({
  meta: {
    name: 'add',
    description: 'Add a feature to your DeepSpace app',
  },
  args: {
    list: {
      type: 'boolean',
      alias: 'l',
      description: 'List available features',
      required: false,
    },
    info: {
      type: 'string',
      description: 'Show details about a feature',
      required: false,
    },
    install: {
      type: 'boolean',
      description: 'Run your package manager after adding dependencies',
      required: false,
    },
    feature: {
      type: 'positional',
      description: 'Feature to install',
      required: false,
    },
    dir: {
      type: 'positional',
      description: 'App directory (default: current directory)',
      required: false,
    },
  },
  run({ args }) {
    const appDir = resolve(args.dir ?? '.')

    // Catalog queries (--list / --info) and bare help never touch the target
    // app, so resolve the installer from THIS running deepspace package. This
    // lets `deepspace add --list` work before the app has run `npm install`.
    if (args.list || args.info || !args.feature) {
      const script = runningScript()
      if (!script) {
        console.error('Could not find the deepspace feature catalog.')
        console.error('Reinstall deepspace (`npm i -g deepspace`) or run inside a DeepSpace app.')
        process.exit(1)
      }
      const passArgs = args.list
        ? ['--list']
        : args.info
          ? ['--info', String(args.info)]
          : ['--help']
      runInstaller(script, passArgs, process.cwd())
    }

    // Install path: the feature is copied into the target app, so it must be a
    // real DeepSpace app with dependencies installed. Check both BEFORE
    // ensureInstallReady, whose "Dependencies not installed" message would
    // otherwise shadow the more useful "not an app / no such dir" guidance.
    if (!existsSync(appDir)) {
      console.error(`Target directory not found: ${appDir}`)
      console.error('Create a new app first: deepspace create <name>')
      process.exit(1)
    }
    if (!isDeepSpaceApp(appDir)) {
      console.error(`Not a DeepSpace app: ${appDir}`)
      console.error('(no wrangler.toml and no "deepspace" dependency found)')
      console.error('Create one with: deepspace create <name>')
      process.exit(1)
    }

    ensureInstallReady(appDir)
    const script = findScript(appDir)
    if (!script) {
      console.error('Could not find the deepspace feature installer.')
      console.error('Looked in:')
      console.error(`  ${join(appDir, 'node_modules', 'deepspace', 'scripts', 'add-feature.cjs')}`)
      console.error(`  ${join(appDir, '.deepspace', 'scripts', 'add-feature.cjs')}`)
      console.error('Are you in a DeepSpace app directory? Try `npm install` first.')
      process.exit(1)
    }

    const passArgs = [args.feature, appDir]
    if (args.install) passArgs.push('--install')
    runInstaller(script, passArgs, appDir)
  },
})
