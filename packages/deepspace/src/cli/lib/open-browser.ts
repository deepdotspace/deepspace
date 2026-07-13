/**
 * Best-effort "open this URL in the default browser".
 *
 * Non-blocking and never throws: every caller has already printed the URL, so
 * a failure to launch the browser is harmless — the user opens it manually.
 * `JSON.stringify` quotes the URL so query strings / special chars can't break
 * out of the shell command.
 */
import { exec } from 'node:child_process'

export function openBrowser(url: string): void {
  const quoted = JSON.stringify(url)
  const cmd =
    process.platform === 'darwin'
      ? `open ${quoted}`
      : process.platform === 'win32'
        ? `start "" ${quoted}`
        : `xdg-open ${quoted}`

  // Swallow errors — the URL was already shown, so launching is optional.
  exec(cmd, () => {})
}
