import type { TokenDebugInfo } from './types'

const BASE64_URL_REGEX = /^[A-Za-z0-9-_]+$/

export function bufferToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let hex = ''
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

export function normalizeArray<T>(value?: T | T[] | null): T[] | undefined {
  if (value == null) return undefined
  if (Array.isArray(value)) {
    return value.length ? value : undefined
  }
  return [value]
}

export function decodeJwtPayload(token: string | null | undefined): TokenDebugInfo | undefined {
  if (!token) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  const payloadSegment = parts[1]
  if (!payloadSegment) return undefined
  if (!BASE64_URL_REGEX.test(payloadSegment)) return undefined
  try {
    const normalized = payloadSegment
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(payloadSegment.length / 4) * 4, '=')
    const bytes = base64ToUint8Array(normalized)
    const json = new TextDecoder().decode(bytes)
    const payload = JSON.parse(json) as Partial<TokenDebugInfo>
    return {
      iss: payload.iss ?? null,
      aud: payload.aud ?? null,
      azp: (payload as Record<string, unknown>)?.azp as string | null ?? null,
      exp: payload.exp ?? null,
      iat: payload.iat ?? null,
    }
  } catch {
    return undefined
  }
}

function base64ToUint8Array(value: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(value)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i)
    }
    return out
  }
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(value, 'base64'))
  }
  throw new Error('No base64 decoder available in current environment')
}
