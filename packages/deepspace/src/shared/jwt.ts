export function decodeJwtPayload<T = Record<string, unknown>>(token: string): T {
  const payloadSegment = token.split('.')[1]
  if (!payloadSegment) {
    throw new Error('JWT payload is missing')
  }
  return JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as T
}
