import { Refusal } from './command'
/**
 * Shared dev-server port resolution for `dev`, `test`, and `kill`.
 *
 * Precedence: explicit `--port` arg > $DEEPSPACE_PORT > DEFAULT_PORT. An
 * out-of-range value is a hard error (exit 1) rather than a silent fallback,
 * so a typo doesn't quietly bind the wrong port.
 */

import { createServer, Socket } from 'node:net'

export const DEFAULT_PORT = 5173

/**
 * Whether `port` is free to bind on `host`. Used by `dev` to pre-probe before
 * spawning vite (which binds with `--host`, i.e. 0.0.0.0), so a busy port gets
 * a friendly `deepspace dev kill` / `--port` remedy instead of vite's raw
 * EADDRINUSE stack (DEV-5). Best-effort: a bind race after the probe still
 * surfaces vite's own error, but the common "server already running" case is
 * caught cleanly.
 */
export function checkPortAvailable(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, host)
  })
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
