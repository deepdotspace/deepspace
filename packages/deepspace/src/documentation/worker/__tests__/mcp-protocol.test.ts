/**
 * Protocol-version negotiation.
 *
 * An audit read the handshake echoing `2025-06-18` while `.well-known/mcp`
 * advertised `2025-11-25` as a disagreement. It is not: the spec requires a
 * server that supports the client's requested version to answer with THAT
 * version. What was missing is the card saying which versions those are, so
 * the two surfaces could be reconciled without reading the source.
 */

import { describe, expect, it } from 'vitest'
import {
  CURRENT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  initializeResponse,
} from '../mcp/protocol'

async function initialize(protocolVersion?: string): Promise<string> {
  const response = initializeResponse({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    ...(protocolVersion === undefined ? {} : { params: { protocolVersion } }),
  })
  const body = (await response.json()) as { result: { protocolVersion: string } }
  return body.result.protocolVersion
}

describe('MCP initialize', () => {
  it('echoes any version it supports, per the lifecycle spec', async () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(await initialize(version)).toBe(version)
    }
  })

  it('falls back to the current version for an unknown or absent request', async () => {
    expect(await initialize('1999-01-01')).toBe(CURRENT_PROTOCOL_VERSION)
    expect(await initialize()).toBe(CURRENT_PROTOCOL_VERSION)
  })

  it('supports the version the discovery card advertises as current', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS.has(CURRENT_PROTOCOL_VERSION)).toBe(true)
  })
})
