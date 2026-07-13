/**
 * HMAC primitives used by the per-app identity tokens (APP_IDENTITY_TOKEN)
 * minted at deploy time and verified on every /internal/* call into the
 * platform worker. Auth-provider-agnostic.
 */

import { bufferToHex } from './utils'

let nodeCryptoPromise: Promise<typeof import('node:crypto') | null> | null = null

async function loadNodeCrypto(): Promise<typeof import('node:crypto') | null> {
  if (!nodeCryptoPromise) {
    nodeCryptoPromise = import('node:crypto')
      .then((module) => module)
      .catch(() => null)
  }
  return nodeCryptoPromise
}

function hasSubtleCrypto(): boolean {
  return typeof globalThis.crypto?.subtle?.importKey === 'function'
}

export async function computeHmacHex(secret: string, payload: string): Promise<string> {
  if (hasSubtleCrypto()) {
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
    return bufferToHex(signature)
  }

  const nodeCrypto = await loadNodeCrypto()
  if (!nodeCrypto) {
    throw new Error('Crypto implementation unavailable for HMAC computation')
  }
  return nodeCrypto.createHmac('sha256', secret).update(payload).digest('hex')
}

export async function timingSafeEqualHex(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) {
    return false
  }

  const nodeCrypto = await loadNodeCrypto()
  if (nodeCrypto?.timingSafeEqual) {
    const aBuf = Buffer.from(a, 'hex')
    const bBuf = Buffer.from(b, 'hex')
    try {
      return nodeCrypto.timingSafeEqual(aBuf, bBuf)
    } catch {
      return false
    }
  }

  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Constant-time equality for arbitrary strings (hash-then-compare: SHA-256
 * normalizes lengths so neither length nor content short-circuits). The one
 * implementation every worker's bearer/secret checks share.
 */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ])
  const aBytes = new Uint8Array(aHash)
  const bBytes = new Uint8Array(bHash)
  let diff = 0
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i]
  return diff === 0
}
