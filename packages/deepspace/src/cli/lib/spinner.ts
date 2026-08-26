import * as p from '@clack/prompts'
import { displayLines } from './cli-format'

export interface Spinner {
  start: (msg?: string) => void
  stop: (msg?: string) => void
  message: (msg?: string) => void
}

// The spinner currently painting the terminal, if any. On Windows a live
// @clack/prompts spinner registers a `process.on('exit')` handler that writes
// a final frame to the TTY; calling process.exit() while it is still running
// makes that write land as libuv tears the TTY handle down —
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` — turning a clean
// exit(1) into an abort. Tracking the active spinner lets error helpers stop it
// (which clears the interval and neuters that exit handler) before they exit.
let activeSpinner: Spinner | null = null

// One chokepoint for machine-readable runs (the routeChildStdoutToStderr
// pattern): a command that emits a JSON envelope calls this once and every
// spinner it creates from then on is a plain static line per phase instead
// of animated TTY repaints. The lines still go through console.log, so a
// command that also redirects stdout (deploy's createDeployOutput) both
// records them for its crash envelope and keeps them off the envelope stream.
let plainProgress = false
export function setPlainProgress(enabled: boolean): void {
  plainProgress = enabled
}

// In a real terminal, @clack/prompts repaints the spinner by writing `\r`
// to overwrite the previous frame. In non-TTY contexts (agents, CI logs,
// pipes, `tee`-ed output) `\r` does nothing and every frame becomes a new
// line — a single long phase floods the log with thousands of repeats.
// When stdout is not a TTY we fall back to one static line per phase.
export function createSpinner(): Spinner {
  const impl: Spinner =
    !plainProgress && process.stdout.isTTY
      ? p.spinner()
      : {
          start: (msg?: string) => {
            if (msg) console.log(msg)
          },
          stop: (msg?: string) => {
            if (msg) console.log(msg)
          },
          message: (msg?: string) => {
            if (msg) console.log(msg)
          },
        }
  // The other output exit. Progress lines were escaped at their call sites and
  // OUTCOME lines were not — `Checking <branch> before push…` sanitised, then
  // `Pushed <branch> → abc1234.` raw — so the split ran through push, pull,
  // status, land and deploy. Every message this wrapper carries is a
  // composed human line, and `displayLines` is idempotent, so the sites that
  // already escape their fields are unaffected.
  const wrapper: Spinner = {
    start: (msg?: string) => {
      activeSpinner = wrapper
      impl.start(msg === undefined ? msg : displayLines(msg))
    },
    stop: (msg?: string) => {
      impl.stop(msg === undefined ? msg : displayLines(msg))
      if (activeSpinner === wrapper) activeSpinner = null
    },
    message: (msg?: string) => impl.message(msg === undefined ? msg : displayLines(msg)),
  }
  return wrapper
}

/**
 * Stop whatever spinner is currently painting, if any. Call on every exit
 * path: a live spinner's repaint interval would keep a naturally-exiting
 * process alive, and its exit-time frame tears down mid-write on Windows
 * (see activeSpinner above). Idempotent and safe when nothing is active.
 */
export function stopActiveSpinner(): void {
  activeSpinner?.stop()
}
