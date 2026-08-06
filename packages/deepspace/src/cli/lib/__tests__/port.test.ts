/**
 * DEV-5: `dev` pre-probes the port with checkPortAvailable so a collision gets
 * a friendly remedy instead of vite's raw EADDRINUSE stack.
 */
import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:net'
import {
  checkPortAvailable,
  isPortListening,
  resolvePort,
  waitForPortListening,
  DEFAULT_PORT,
} from '../port'

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

/**
 * The readiness and pre-flight probes must answer "is a server listening
 * here", and only a CONNECT probe does. A bind probe answers "can I bind this
 * exact address", which on macOS/BSD returns true for 127.0.0.1 while a server
 * holds 0.0.0.0 — so `dev start --json` never saw its own server come up, and
 * the port pre-check waved through a port vite then failed to take.
 */
describe('isPortListening', () => {
  it('detects a server bound to 0.0.0.0 (bind probes do not)', async () => {
    const { server, port } = await listenOnEphemeral()
    try {
      expect(await isPortListening(port, '0.0.0.0')).toBe(true)
      expect(await isPortListening(port, '127.0.0.1')).toBe(true)
      // The old probe's answer, pinned so the regression cannot come back
      // silently: it reports the port FREE while the server is serving.
      expect(await checkPortAvailable(port, '127.0.0.1')).toBe(true)
    } finally {
      server.close()
    }
  })

  it('reports nothing listening on a free port', async () => {
    const { server, port } = await listenOnEphemeral()
    await new Promise((resolve) => server.close(resolve))
    expect(await isPortListening(port, '127.0.0.1')).toBe(false)
  })
})

describe('waitForPortListening', () => {
  it('returns as soon as the server answers', async () => {
    const { server, port } = await listenOnEphemeral()
    try {
      expect(await waitForPortListening(port, '0.0.0.0', 5_000)).toBe(true)
    } finally {
      server.close()
    }
  })

  it('gives up and reports failure rather than hanging', async () => {
    const { server, port } = await listenOnEphemeral()
    await new Promise((resolve) => server.close(resolve))
    expect(await waitForPortListening(port, '127.0.0.1', 600)).toBe(false)
  })
})
