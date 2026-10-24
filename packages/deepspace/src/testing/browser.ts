import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/**
 * Share this with the CLI preflight so a container's existing Chromium can be
 * used without downloading Playwright's browser. Older app configs can adopt
 * it with `use: { launchOptions: chromiumLaunchOptions() }`.
 */
export function chromiumLaunchOptions(): { executablePath?: string } {
  const executablePath = process.env.DEEPSPACE_TEST_BROWSER_EXECUTABLE_PATH
  if (!executablePath) return {}

  try {
    if (!isAbsolute(executablePath) || !statSync(executablePath).isFile()) throw new Error()
    accessSync(executablePath, constants.X_OK)
  } catch {
    throw new Error(
      'DEEPSPACE_TEST_BROWSER_EXECUTABLE_PATH must name an existing executable file using an absolute path. ' +
        'Point it to your installed Chromium/Chrome, or unset it to use the Playwright-managed browser.',
    )
  }
  return { executablePath }
}
