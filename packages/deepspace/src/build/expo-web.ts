/**
 * `expoWeb()` — serve an app's Expo client on the web.
 *
 * For apps whose only UI is the Expo app in `mobile/` (iPhone, iPad, Mac):
 * at `vite build`, which `deepspace deploy` runs, it exports that app for
 * the web and writes it over the client assets the Worker serves, so one
 * React Native tree is also the app's web page. `deepspace/native` resolves
 * to its browser build there.
 *
 * It also writes the page as `_spa.html`, the shell the Worker's client-route
 * fallback serves, so a refresh at any path loads the app.
 *
 * ```ts
 * // vite.config.ts
 * plugins: [deepspaceBuild(), expoWeb({ mobileDir: fileURLToPath(new URL('./mobile', import.meta.url)) })]
 * ```
 *
 * Structural like `deepspaceBuild()`, so the SDK carries no Vite dependency.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ExpoWebOptions {
  /** The Expo app's directory (its own package.json and node_modules). */
  mobileDir: string
}

export interface ExpoWebPlugin {
  name: string
  apply: 'build'
  applyToEnvironment(environment: { name: string }): boolean
  writeBundle(options: { dir?: string }): void
}

export function expoWeb({ mobileDir }: ExpoWebOptions): ExpoWebPlugin {
  return {
    name: 'deepspace:expo-web',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'client',
    writeBundle(options) {
      const outDir = options.dir
      if (!outDir) throw new Error('expoWeb: the client build has no output directory')
      if (!existsSync(join(mobileDir, 'node_modules'))) {
        throw new Error(`expoWeb: run \`npm install\` in ${mobileDir} first`)
      }
      const exported = mkdtempSync(join(tmpdir(), 'deepspace-expo-web-'))
      try {
        // --clear: Metro's transform cache lives in the shared temp dir and is
        // not keyed by project, so another Expo app's export can leave its
        // inlined app config (its app id) in this bundle.
        execFileSync('npx', ['expo', 'export', '--platform', 'web', '--clear', '--output-dir', exported], {
          cwd: mobileDir,
          stdio: 'pipe',
          env: { ...process.env, CI: '1', NODE_ENV: 'production' },
        })
        cpSync(exported, outDir, { recursive: true, force: true })
        cpSync(join(exported, 'index.html'), join(outDir, '_spa.html'))
      } catch (error) {
        const output = error as { stdout?: Buffer; stderr?: Buffer }
        const detail = [output.stdout?.toString(), output.stderr?.toString()].filter(Boolean).join('\n')
        throw new Error(`expoWeb: the web export failed\n${detail || String(error)}`)
      } finally {
        rmSync(exported, { recursive: true, force: true })
      }
    },
  }
}
