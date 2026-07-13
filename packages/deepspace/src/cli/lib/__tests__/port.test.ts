/**
 * DEV-5: `dev` pre-probes the port with checkPortAvailable so a collision gets
 * a friendly remedy instead of vite's raw EADDRINUSE stack.
 */
import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:net'
import { checkPortAvailable, resolvePort, DEFAULT_PORT } from '../port'

function listenOnEphemeral(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '0.0.0.0', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, port })
    })
  })
}

describe('checkPortAvailable (DEV-5)', () => {
  it('reports a bound port as unavailable and a freed port as available', async () => {
    const { server, port } = await listenOnEphemeral()
    try {
      expect(await checkPortAvailable(port)).toBe(false)
    } finally {
      await new Promise((r) => server.close(r))
    }
    // Same port is free once the server closed.
    expect(await checkPortAvailable(port)).toBe(true)
  })
})

describe('resolvePort', () => {
  it('defaults to DEFAULT_PORT with no arg or env', () => {
    delete process.env.DEEPSPACE_PORT
    expect(resolvePort()).toBe(DEFAULT_PORT)
  })
  it('parses a valid explicit port', () => {
    expect(resolvePort('8790')).toBe(8790)
  })
})
