/**
 * The shared files-API limit and failure reader.
 *
 * The behaviour worth pinning is that a response the app did NOT write — an
 * edge HTML error page, an empty body, a proxy notice — never reaches the user
 * as its own text. Feeding those into `JSON.parse` is what produced
 * "Unexpected token '<' … is not valid JSON" where a size limit belonged.
 */

import { describe, expect, it } from 'vitest'
import { MAX_APP_FILE_BYTES, describeFilesFailure, formatBytes } from '../app-files'

const HTML_413 =
  '<!DOCTYPE html><html><head><title>413 Request Entity Too Large</title></head><body>413</body></html>'

describe('describeFilesFailure', () => {
  it('passes through the app’s own JSON refusal', () => {
    expect(describeFilesFailure(415, JSON.stringify({ error: 'Unsupported media type: text/html' }))).toBe(
      'Unsupported media type: text/html',
    )
  })

  it('turns an edge HTML 413 into a named size limit', () => {
    const message = describeFilesFailure(413, HTML_413)
    expect(message).toContain('too large')
    expect(message).toContain(formatBytes(MAX_APP_FILE_BYTES))
    expect(message).not.toContain('<')
    expect(message).not.toMatch(/JSON|Unexpected token/i)
  })

  it('describes an empty body by status rather than echoing nothing', () => {
    expect(describeFilesFailure(502, '')).toContain('502')
  })

  it('does not echo a body that only looks like JSON', () => {
    const message = describeFilesFailure(500, '{not really json')
    expect(message).not.toContain('not really json')
    expect(message).toContain('500')
  })

  it('names the common client refusals', () => {
    expect(describeFilesFailure(401, '')).toContain('Not authorized')
    expect(describeFilesFailure(403, '')).toContain('Not authorized')
    expect(describeFilesFailure(415, HTML_413)).toContain('file type')
  })
})

describe('formatBytes', () => {
  it('scales through B, KiB and MiB', () => {
    expect(formatBytes(900)).toBe('900 B')
    expect(formatBytes(4096)).toBe('4 KiB')
    expect(formatBytes(MAX_APP_FILE_BYTES)).toBe('25.0 MiB')
  })
})
