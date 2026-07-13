import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
// Namespace import on purpose: a named `import { registerHooks }` would itself
// crash at load time on the very Nodes this preflight exists to catch.
import * as nodeModule from 'node:module'
import { resolve } from 'node:path'

/**
 * The Cloudflare Vite plugin uses `module.registerHooks` (Node 22.15+ /
 * 23.5+). On older Nodes, `vite build` and the dev server die with a cryptic
 * ESM error from deep inside the plugin:
 *
 *   SyntaxError: The requested module 'node:module' does not provide an
 *   export named 'registerHooks'
 *
 * Catch it before spawning Vite and print the actual fix instead. Feature-
 * detected rather than version-pinned so the check can't go stale; the
 * `hasRegisterHooks` parameter exists only for tests.
 */
export function preflightNodeVersion(
  command: string,
  hasRegisterHooks: boolean = typeof (nodeModule as { registerHooks?: unknown }).registerHooks ===
    'function',
): void {
  if (hasRegisterHooks) return
  console.error(
    `deepspace ${command} requires Node 22.15 or newer (found v${process.versions.node}).`,
  )
  console.error('Install the current LTS from https://nodejs.org and re-run.')
  process.exit(1)
}

// 0xC0000135 = STATUS_DLL_NOT_FOUND on Windows. Node reports it as a signed int.
const DLL_NOT_FOUND = -1073741515

/**
 * On Windows, the Cloudflare Workers runtime (`workerd.exe`) is built with
 * MSVC and links against `vcruntime140.dll`. A bare Windows install (Server
 * 2022, Server Core, minimal Windows 11) does not ship those DLLs, so workerd
 * exits immediately with STATUS_DLL_NOT_FOUND. Miniflare then surfaces this as
 * "Error: write EOF" because workerd closed the stdin pipe before reading its
 * config — an error with no JS stack trace and no hint at the cause.
 *
 * This preflight catches the case and prints the actual fix (install VC++
 * Redistributable). Skip silently if workerd isn't installed yet or runs fine.
 */
export function preflightWindowsWorkerd(appDir: string): void {
  if (process.platform !== 'win32') return

  const workerdExe = resolve(
    appDir,
    'node_modules',
    '@cloudflare',
    'workerd-windows-64',
    'bin',
    'workerd.exe',
  )
  if (!existsSync(workerdExe)) return

  try {
    execFileSync(workerdExe, ['--help'], { stdio: 'pipe', timeout: 10_000 })
    return
  } catch (err: unknown) {
    const status = (err as { status?: number }).status
    if (status !== DLL_NOT_FOUND) return

    console.error('')
    console.error('  workerd (Cloudflare Workers runtime) cannot start on this system.')
    console.error('  It needs the Microsoft Visual C++ Redistributable, which is not installed.')
    console.error('')
    console.error('  Install it with any of:')
    console.error('    winget install Microsoft.VCRedist.2015+.x64')
    console.error('    choco install -y vcredist140')
    console.error('    https://aka.ms/vs/17/release/vc_redist.x64.exe')
    console.error('')
    console.error('  Then restart this terminal and re-run the command.')
    console.error('')
    process.exit(1)
  }
}
