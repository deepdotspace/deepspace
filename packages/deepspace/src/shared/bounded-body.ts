export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Body exceeds ${maxBytes} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

/**
 * Read a Request or Response body under an exact byte ceiling. Content-Length
 * permits an early refusal, while streaming enforcement keeps chunked/forged
 * bodies from being fully allocated before the caller can reject them.
 */
export async function readBoundedBodyText(
  source: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer')
  }

  const declared = source.headers.get('content-length')
  if (declared && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) {
    await source.body?.cancel().catch(() => undefined)
    throw new BodyTooLargeError(maxBytes)
  }
  if (!source.body) return ''

  const reader = source.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new BodyTooLargeError(maxBytes)
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}
