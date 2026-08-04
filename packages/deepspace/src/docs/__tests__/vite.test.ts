import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { serveDocsDevAsset } from '../vite'

function responseRecorder(): {
  response: ServerResponse
  writeHead: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
} {
  const writeHead = vi.fn()
  const end = vi.fn()
  return {
    response: { writeHead, end } as unknown as ServerResponse,
    writeHead,
    end,
  }
}

describe('DeepSpace docs Vite bridge', () => {
  it('serves only the generated reserved asset namespace with exact MIME types', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'deepspace-docs-vite-'))
    mkdirSync(join(outputDir, '.well-known', 'agent-skills'), { recursive: true })
    writeFileSync(join(outputDir, '.well-known', 'agent-skills', 'index.json'), '{"skills":[]}')
    const recorded = responseRecorder()

    const handled = serveDocsDevAsset(
      outputDir,
      { url: '/_docs/.well-known/agent-skills/index.json' } as IncomingMessage,
      recorded.response,
    )

    expect(handled).toBe(true)
    expect(recorded.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      }),
    )
    expect(String(recorded.end.mock.calls[0]?.[0])).toBe('{"skills":[]}')
  })

  it('passes application requests through and refuses traversal inside the docs namespace', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'deepspace-docs-vite-'))
    const passthrough = responseRecorder()
    expect(
      serveDocsDevAsset(
        outputDir,
        { url: '/api/widgets' } as IncomingMessage,
        passthrough.response,
      ),
    ).toBe(false)
    expect(passthrough.writeHead).not.toHaveBeenCalled()

    const traversal = responseRecorder()
    expect(
      serveDocsDevAsset(
        outputDir,
        { url: '/_docs/%2e%2e%2fpackage.json' } as IncomingMessage,
        traversal.response,
      ),
    ).toBe(true)
    expect(traversal.writeHead).toHaveBeenCalledWith(404, expect.any(Object))
  })
})
