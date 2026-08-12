/**
 * Best-effort "open this URL in the default browser".
 *
 * Non-blocking and never throws: every caller has already printed the URL, so
 * a failure to launch the browser is harmless — the user opens it manually.
 * `JSON.stringify` quotes the URL so query strings / special chars can't break
 * out of the shell command.
 */
import { spawn } from 'node:child_process'

export function openBrowser(url: string): void {
  const quoted = JSON.stringify(url)
  const cmd =
    process.platform === 'darwin'
      ? `open ${quoted}`
      : process.platform === 'win32'
        ? `start "" ${quoted}`
        : `xdg-open ${quoted}`

  // A ref'd exec() child (plus its stdout/stderr pipes) held the
  // naturally-exiting process (lib/command.ts finishCommand) open until the
  // launcher exited — measured ~3s vs ~30ms. Detach with no stdio and unref
  // so nothing waits on it; `windowsHide` stops `detached` from flashing a
  // console window on Windows. The no-op 'error' handler swallows launch
  // failures — the URL was already shown, so launching is optional.
  spawn(cmd, { shell: true, detached: true, stdio: 'ignore', windowsHide: true })
    .on('error', () => {})
    .unref()
}
