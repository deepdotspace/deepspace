import { describe, expect, it } from 'vitest'
import { readBoundedRequestText, RequestBodyTooLargeError } from '../request-body'

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

describe('readBoundedRequestText', () => {
  it('rejects an oversized declared length before pulling the stream', async () => {
    const request = {
      body: new ReadableStream<Uint8Array>(),
      headers: new Headers({ 'Content-Length': '65' }),
    } as Request

    await expect(readBoundedRequestText(request, 64)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    )
    expect(request.body?.locked).toBe(false)
  })

  it('cancels a chunked body as soon as its cumulative bytes cross the limit', async () => {
    await expect(readBoundedRequestText(streamedRequest(['1234', '5678', '9']), 8))
      .rejects.toBeInstanceOf(RequestBodyTooLargeError)
  })

  it('counts UTF-8 bytes while returning decoded text', async () => {
    await expect(readBoundedRequestText(streamedRequest(['é', ' ok']), 5))
      .resolves.toBe('é ok')
  })
})
