import * as p from '@clack/prompts'

// In a real terminal, @clack/prompts repaints the spinner by writing `\r`
// to overwrite the previous frame. In non-TTY contexts (agents, CI logs,
// pipes, `tee`-ed output) `\r` does nothing and every frame becomes a new
// line — a single long phase floods the log with thousands of repeats.
// When stdout is not a TTY we fall back to one static line per phase.
export function createSpinner(): {
  start: (msg?: string) => void
  stop: (msg?: string) => void
  message: (msg?: string) => void
} {
  if (process.stdout.isTTY) return p.spinner()
  return {
    start: (msg?: string) => { if (msg) console.log(msg) },
    stop: (msg?: string) => { if (msg) console.log(msg) },
    message: (msg?: string) => { if (msg) console.log(msg) },
  }
}
