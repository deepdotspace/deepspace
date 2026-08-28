import { describe, expect, it } from 'vitest'
import { readBoundedBodyText, BodyTooLargeError } from '../bounded-body'

function streamedRequest(chunks: string[], contentLength?: string): Request {
  const encoder = new TextEncoder()
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index]
      if (chunk === undefined) {
        controller.close()
        return
      }
      index += 1
      controller.enqueue(encoder.encode(chunk))
    },
  })
  return {
    body,
    headers: new Headers(contentLength ? { 'Content-Length': contentLength } : undefined),
  } as Request
}

describe('readBoundedBodyText', () => {
  it('rejects an oversized declared length before pulling the stream', async () => {
    const request = {
      body: new ReadableStream<Uint8Array>(),
      headers: new Headers({ 'Content-Length': '65' }),
    } as Request

    await expect(readBoundedBodyText(request, 64)).rejects.toBeInstanceOf(BodyTooLargeError)
    expect(request.body?.locked).toBe(false)
  })

  it('cancels a chunked body as soon as its cumulative bytes cross the limit', async () => {
    await expect(
      readBoundedBodyText(streamedRequest(['1234', '5678', '9']), 8),
    ).rejects.toBeInstanceOf(BodyTooLargeError)
  })

  it('counts UTF-8 bytes while returning decoded text', async () => {
    await expect(readBoundedBodyText(streamedRequest(['é', ' ok']), 5)).resolves.toBe('é ok')
  })
})
