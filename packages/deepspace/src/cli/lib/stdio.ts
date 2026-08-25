import { InputError } from './cli-errors'

/** Bound for credential and secrets documents; integration bodies retain the
 * same size behavior whether they arrive from stdin or a named file. */
export const MAX_STDIN_BYTES = 1024 * 1024

/**
 * Read a piped stream to EOF without synchronously reading fd 0.
 *
 * Accessing `process.stdin` makes Node drive fd 0 through libuv in
 * non-blocking mode. A later `readFileSync(0)` can therefore see a momentarily
 * empty pipe and throw EAGAIN instead of waiting for the producer. Accumulating
 * asynchronous chunks is the supported way to consume that stream. Decode
 * once at the end so a multibyte character split across chunks stays intact.
 */
export async function readStreamText(
  stream: AsyncIterable<string | Uint8Array>,
  maxBytes?: number,
): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : Buffer.from(chunk)
    total += bytes.byteLength
    if (maxBytes !== undefined && total > maxBytes) {
      throw new InputError(
        `Input on stdin exceeds ${Math.floor(maxBytes / 1024)} KiB — refusing to buffer more.`,
        'input_too_large',
      )
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf-8')
}
