/**
 * Shared dev-server port resolution for `dev`, `test`, and `kill`.
 *
 * Precedence: explicit `--port` arg > $DEEPSPACE_PORT > DEFAULT_PORT. An
 * out-of-range value is a hard error (exit 1) rather than a silent fallback,
 * so a typo doesn't quietly bind the wrong port.
 */

import { createServer } from 'node:net'

export const DEFAULT_PORT = 5173

/**
 * Whether `port` is free to bind on `host`. Used by `dev` to pre-probe before
 * spawning vite (which binds with `--host`, i.e. 0.0.0.0), so a busy port gets
 * a friendly `deepspace kill` / `--port` remedy instead of vite's raw
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

export function resolvePort(arg?: string): number {
  const raw = arg ?? process.env.DEEPSPACE_PORT
  if (!raw) return DEFAULT_PORT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`Invalid port: ${raw}. Must be an integer between 1 and 65535.`)
    process.exit(1)
  }
  return n
}
