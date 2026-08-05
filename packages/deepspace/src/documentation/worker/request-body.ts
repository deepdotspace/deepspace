export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`)
    this.name = 'RequestBodyTooLargeError'
  }
}

/**
 * Read a request body under an exact byte ceiling. Content-Length permits an
 * early refusal, while streaming enforcement keeps chunked/forged requests
 * from being fully allocated before the public route can reject them.
 */
export async function readBoundedRequestText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer')
  }

  const declared = request.headers.get('content-length')
  if (declared && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes)
  }
  if (!request.body) return ''

  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new RequestBodyTooLargeError(maxBytes)
    }
    text += decoder.decode(chunk.value, { stream: true })
  }
  return text + decoder.decode()
}
