import { Refusal } from './command'
/**
 * Shared dev-server port resolution for `dev`, `test`, and `kill`.
 *
 * Precedence: explicit `--port` arg > $DEEPSPACE_PORT > DEFAULT_PORT. An
 * out-of-range value is a hard error (exit 1) rather than a silent fallback,
 * so a typo doesn't quietly bind the wrong port.
 */

import { Socket } from 'node:net'

export const DEFAULT_PORT = 5173

/**
 * The one busy-port guard for `dev start` and `test run` (DEV-5): refuse a
 * held port with a friendly `deepspace dev kill` / `--port` remedy instead of
 * vite's raw --strictPort EADDRINUSE stack. Three states, one answer each:
 * port free → proceed; port held by a live server (HTTP answers) → refuse
 * now, it won't go away on its own; port held but HTTP dead — a previous
 * run's server still shutting down — → bounded wait for it to free, so
 * back-to-back runs don't flake, then the same refusal. A CONNECT probe, not
 * a bind probe: SO_REUSEADDR lets a wildcard bind succeed while a server
 * holds 127.0.0.1, so a bind probe reports a live loopback server as absent.
 * Best-effort: a race after the probe still surfaces vite's own error.
 */
export async function ensurePortFree(port: number, host: string, waitMs = 15_000): Promise<void> {
  if (!(await isPortListening(port, host))) return
  if (!(await isHttpResponding(port))) {
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (!(await isPortListening(port, host))) return
    }
  }
  // ALWAYS explicit: bare `dev kill` resolves its target through dev's own
  // precedence (worktree port, the app's last launch.json port, …), which
  // can name a DIFFERENT port than the one that just refused — the r2 AX
  // pass looped exactly there: refuse on 5173 → kill targets 5310 →
  // "portFree: true" about a port nobody asked about → refuse on 5173.
  const killArgv = ['deepspace', 'dev', 'kill', '--port', String(port)]
  throw new Refusal(
    `Port ${port} is already in use.\n` +
      `Free it with \`${killArgv.join(' ')}\`, or use another port: \`--port <other>\`.`,
    'port_in_use',
    { extra: { port } },
  )
}

/** Whether an HTTP server on the loopback port answers at all (any status). */
async function isHttpResponding(port: number, timeoutMs = 2000): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) })
    return true
  } catch {
    return false
  }
}

/**
 * Whether something is already accepting connections on `host:port`.
 *
 * A CONNECT probe, not a bind probe, because binding answers the wrong
 * question. Vite binds `0.0.0.0`; asking "can I bind 127.0.0.1:5173?" on
 * macOS/BSD answers YES while vite is serving there — so a bind probe reports
 * a live server as absent, and reports a port as free that vite then fails to
 * take with EADDRINUSE. Connecting asks the question both callers actually
 * have: is a server answering here?
 */
export function isPortListening(port: number, host: string, timeoutMs = 500): Promise<boolean> {
  // 0.0.0.0 is a bind address; the reachable name for it is the loopback.
  const target = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return new Promise((resolve) => {
    const socket = new Socket()
    const done = (listening: boolean) => {
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, target)
  })
}

/**
 * Wait until the dev server answers. This is the only readiness signal
 * available: vite inherits stdio, so its "Local: http://…" line is never ours
 * to parse. `signal` ends the poll early (resolving false) once the caller
 * knows the server can no longer come up — the poll's ref'd socket/timer must
 * not keep a naturally-exiting process alive.
 */
export async function waitForPortListening(
  port: number,
  host: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !signal?.aborted) {
    if (await isPortListening(port, host)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

/**
 * THE dev-server port precedence, shared by `dev start`, `test run`, and
 * `dev kill` so all three name the same server (DEV-2, and the r2 AX loop
 * where `kill` freed a different port than the one `dev` refused on):
 *
 *   explicit --port > $DEEPSPACE_PORT > the checkout's worktree port >
 *   the app's last launch.json port (kill only) > DEFAULT_PORT
 *
 * Callers supply the worktree/launch sources (they differ in HOW those are
 * found — dev derives a fresh worktree port, test and kill read the recorded
 * one); only the ORDER lives here. The sources are thunks, consulted only
 * when nothing above them answers: an explicit --port run must not spawn the
 * git/launch.json lookups it will never use (test-runner pins that no
 * process is spawned before a port refusal).
 */
export function resolveDevServerPort(opts: {
  arg?: string
  worktree?: () => number | null
  appLaunch?: () => number | null
}): number {
  if (opts.arg) return resolvePort(opts.arg)
  if (process.env.DEEPSPACE_PORT) return resolvePort()
  return opts.worktree?.() ?? opts.appLaunch?.() ?? DEFAULT_PORT
}

export function resolvePort(arg?: string): number {
  const raw = arg ?? process.env.DEEPSPACE_PORT
  if (!raw) return DEFAULT_PORT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    // Throw, never process.exit: these helpers run inside runtime command
    // bodies, and an exit skips the runtime's envelope — a --json caller
    // would get code 1 with an EMPTY stdout, the exact hole the runtime
    // exists to close.
    throw new Refusal(`Invalid port: ${raw}. Must be an integer between 1 and 65535.`, 'invalid_port')
  }
  return n
}
