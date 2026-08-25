import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { MAX_STDIN_BYTES, readStreamText } from '../stdio'

describe('readStreamText', () => {
  it('waits for delayed chunks and decodes split UTF-8 once at EOF', async () => {
    const bytes = Buffer.from('café 🚀')
    let index = 0
    const chunks = [bytes.subarray(0, 4), bytes.subarray(4, 7), bytes.subarray(7)]
    const stream = new Readable({
      read() {
        setTimeout(() => this.push(index < chunks.length ? chunks[index++] : null), 1)
      },
    })

    await expect(readStreamText(stream)).resolves.toBe('café 🚀')
  })

  it('refuses once the running byte total crosses its bound', async () => {
    await expect(readStreamText(Readable.from(['123', '45']), 4)).rejects.toMatchObject({
      code: 'input_too_large',
    })
  })

  it('keeps unbounded callers transport-neutral with named-file input', async () => {
    const input = 'x'.repeat(MAX_STDIN_BYTES + 1)
    await expect(readStreamText(Readable.from([input]))).resolves.toBe(input)
  })
})
