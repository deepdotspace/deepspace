import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('base scaffold static headers', () => {
  it('uses the Cloudflare static-assets header contract without constraining app integrations', () => {
    const headers = readFileSync(
      fileURLToPath(new URL('../../templates/base/public/_headers', import.meta.url)),
      'utf8',
    )
    expect(headers).toContain(
      "Content-Security-Policy: object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    )
    expect(headers).toContain('Referrer-Policy: strict-origin-when-cross-origin')
    expect(headers).toContain('X-Content-Type-Options: nosniff')
  })
})

describe('base scaffold user visibility', () => {
  it('does not let regular members enumerate full users rows', () => {
    const schema = readFileSync(
      fileURLToPath(new URL('../../templates/base/src/schemas/users-schema.ts', import.meta.url)),
      'utf8',
    )

    expect(schema).toContain("member: { read: 'own', create: false, update: 'own', delete: false }")
    expect(schema).not.toContain('member: { read: true')
  })
})

describe('base scaffold dependency contract', () => {
  it('uses the same Zod major as the SDK-owned agent runtime', () => {
    const template = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../templates/base/package.json', import.meta.url)),
        'utf8',
      ),
    ) as { dependencies: Record<string, string> }
    const sdk = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../deepspace/package.json', import.meta.url)),
        'utf8',
      ),
    ) as { dependencies: Record<string, string> }

    expect(template.dependencies.zod).toMatch(/^\^4\./)
    expect(template.dependencies.zod).toBe(sdk.dependencies.zod)
  })

  it('approves only the install scripts required by the build runtime', () => {
    const template = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../templates/base/package.json', import.meta.url)),
        'utf8',
      ),
    ) as { allowScripts?: Record<string, boolean> }

    expect(template.allowScripts).toEqual({ esbuild: true, workerd: true })
  })

  it('does not install unused model providers in every generated app', () => {
    const template = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../templates/base/package.json', import.meta.url)),
        'utf8',
      ),
    ) as { dependencies: Record<string, string> }

    expect(template.dependencies.ai).toBeDefined()
    expect(template.dependencies['@ai-sdk/anthropic']).toBeUndefined()
    expect(template.dependencies['@ai-sdk/openai']).toBeUndefined()
    expect(template.dependencies['@ai-sdk/openai-compatible']).toBeUndefined()
  })
})
