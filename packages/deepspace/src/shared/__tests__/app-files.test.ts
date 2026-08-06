/**
 * The shared files-API limit and failure reader.
 *
 * The behaviour worth pinning is that a response the app did NOT write — an
 * edge HTML error page, an empty body, a proxy notice — never reaches the user
 * as its own text. Feeding those into `JSON.parse` is what produced
 * "Unexpected token '<' … is not valid JSON" where a size limit belonged.
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_APP_FILE_BYTES,
  MAX_BASE64_UPLOAD_BYTES,
  MAX_UPLOAD_PARTS,
  MAX_UPLOAD_REQUEST_BYTES,
  UPLOAD_PART_BYTES,
  describeFilesFailure,
  formatBytes,
  planUploadParts,
} from '../app-files'

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
  it('scales through B, KiB, MiB and GiB', () => {
    expect(formatBytes(900)).toBe('900 B')
    expect(formatBytes(4096)).toBe('4 KiB')
    expect(formatBytes(MAX_UPLOAD_REQUEST_BYTES)).toBe('25.0 MiB')
    expect(formatBytes(MAX_APP_FILE_BYTES)).toBe('1.0 GiB')
  })
})

describe('upload limits', () => {
  // The three numbers answer three questions and the relationships between
  // them are what make the transport work. A change that breaks one of these
  // is a change that strands a client mid-upload.
  it('keeps the part size inside one request, with envelope headroom', () => {
    expect(UPLOAD_PART_BYTES).toBeLessThan(MAX_UPLOAD_REQUEST_BYTES)
  })

  it('keeps the part size inside R2’s own part rules', () => {
    // R2 refuses a non-final part under 5 MiB (error 10011) and allows at
    // most 10,000 parts.
    expect(UPLOAD_PART_BYTES).toBeGreaterThanOrEqual(5 * 1024 * 1024)
    expect(MAX_UPLOAD_PARTS).toBeLessThanOrEqual(10_000)
  })

  it('allows enough parts to reach the ceiling', () => {
    expect(MAX_UPLOAD_PARTS * UPLOAD_PART_BYTES).toBeGreaterThanOrEqual(MAX_APP_FILE_BYTES)
  })

  it('keeps the in-flight worst case near the ceiling, not near the request bound', () => {
    // MAX_UPLOAD_PARTS is computed against the PART size, so the server has to
    // refuse a part larger than that. If parts were only bounded by the
    // request bound, the real in-flight maximum would be 52 × 25 MiB = 1300 MiB
    // while the advertised ceiling stayed 1 GiB.
    const worstCase = MAX_UPLOAD_PARTS * UPLOAD_PART_BYTES
    expect(worstCase).toBeLessThanOrEqual(MAX_APP_FILE_BYTES + UPLOAD_PART_BYTES)
    expect(MAX_UPLOAD_PARTS * MAX_UPLOAD_REQUEST_BYTES).toBeGreaterThan(worstCase)
  })

  it('budgets base64 on the ENCODED body, which is what must fit a request', () => {
    // 4 characters per 3 bytes: a payload sized only by its decoded length can
    // sit under the request bound and still produce a body a third larger.
    expect(MAX_BASE64_UPLOAD_BYTES).toBeLessThan(MAX_UPLOAD_REQUEST_BYTES)
    const encoded = Math.ceil((MAX_BASE64_UPLOAD_BYTES * 4) / 3)
    expect(encoded).toBeLessThanOrEqual(MAX_UPLOAD_REQUEST_BYTES)
    // And the naive decoded-only budget would NOT have fit.
    expect(Math.ceil((MAX_UPLOAD_REQUEST_BYTES * 4) / 3)).toBeGreaterThan(MAX_UPLOAD_REQUEST_BYTES)
  })
})

describe('planUploadParts', () => {
  it('numbers parts from 1 and covers the file exactly once', () => {
    const parts = planUploadParts(4500, 1000)
    expect(parts.map((p) => p.partNumber)).toEqual([1, 2, 3, 4, 5])
    expect(parts[0]).toEqual({ partNumber: 1, start: 0, end: 1000 })
    expect(parts.at(-1)).toEqual({ partNumber: 5, start: 4000, end: 4500 })
    // No gaps, no overlap.
    parts.forEach((part, index) => {
      if (index > 0) expect(part.start).toBe(parts[index - 1].end)
    })
  })

  it('makes every part but the last exactly one size — R2 requires it', () => {
    const parts = planUploadParts(4500, 1000)
    for (const part of parts.slice(0, -1)) expect(part.end - part.start).toBe(1000)
    expect(parts.at(-1)!.end - parts.at(-1)!.start).toBeLessThanOrEqual(1000)
  })

  it('plans one whole part when the file divides evenly', () => {
    expect(planUploadParts(2000, 1000)).toHaveLength(2)
  })

  it('plans nothing for an empty file', () => {
    expect(planUploadParts(0, 1000)).toEqual([])
  })

  it('stays within the server’s part budget at the ceiling', () => {
    expect(planUploadParts(MAX_APP_FILE_BYTES, UPLOAD_PART_BYTES).length).toBeLessThanOrEqual(
      MAX_UPLOAD_PARTS,
    )
  })
})
