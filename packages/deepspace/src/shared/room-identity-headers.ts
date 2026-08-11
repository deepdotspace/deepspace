/**
 * Identity claims cross from an app Worker to its private room Durable Object
 * in headers. Header values are ByteStrings, while verified profile claims may
 * contain arbitrary Unicode or control characters, so carry each value as
 * UTF-8 base64url rather than writing the claim directly.
 */

const BASE64URL = /^[A-Za-z0-9_-]*$/
const IDENTITY_QUERY_PARAMS = ['userId', 'userName', 'userEmail', 'userImageUrl', 'role'] as const
const IDENTITY_HEADERS = [
  'x-user-id',
  'x-user-name',
  'x-user-email',
  'x-user-image-url',
  'x-user-role',
] as const

interface RoomAuth {
  userId: string
  claims: { name?: string; email?: string; image?: string }
}

export function encodeRoomIdentityHeader(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function decodeRoomIdentityHeader(value: string | null): string | undefined {
  if (value === null || !BASE64URL.test(value) || value.length % 4 === 1) return undefined
  const base64 = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), '=')
  try {
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/** Strip public identity inputs and forward only verified room identity. */
export function authenticatedRoomRequest(
  request: Request,
  auth: RoomAuth | null,
  identity?: { role?: string },
): Request {
  const url = new URL(request.url)
  url.searchParams.delete('token')
  for (const key of IDENTITY_QUERY_PARAMS) url.searchParams.delete(key)

  const forwarded = new Request(url.toString(), request)
  for (const header of IDENTITY_HEADERS) forwarded.headers.delete(header)
  if (!auth) return forwarded

  forwarded.headers.set('x-user-id', encodeRoomIdentityHeader(auth.userId))
  if (auth.claims.name) {
    forwarded.headers.set('x-user-name', encodeRoomIdentityHeader(auth.claims.name))
  }
  if (auth.claims.email) {
    forwarded.headers.set('x-user-email', encodeRoomIdentityHeader(auth.claims.email))
  }
  if (auth.claims.image) {
    forwarded.headers.set('x-user-image-url', encodeRoomIdentityHeader(auth.claims.image))
  }
  if (identity?.role) {
    forwarded.headers.set('x-user-role', encodeRoomIdentityHeader(identity.role))
  }
  return forwarded
}
