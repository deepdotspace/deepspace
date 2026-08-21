import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { installStaleChunkRecovery } from '../../templates/base/src/stale-chunk-recovery'

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

describe('base scaffold route loading', () => {
  it('code-splits route modules so public pages do not preload the app graph', () => {
    const entry = readFileSync(
      fileURLToPath(new URL('../../templates/base/src/main.tsx', import.meta.url)),
      'utf8',
    )

    expect(entry).toContain("from '@generouted/react-router/lazy'")
    expect(entry).not.toContain("from '@generouted/react-router'")
  })

  it('reloads only once when the initial lazy route fails twice', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    }
    let reloads = 0
    let firstFailure = (_event: Pick<Event, 'preventDefault'>) => {}
    installStaleChunkRecovery(
      { state: { initialized: false, errors: null }, subscribe: () => () => {} },
      {
        storage,
        reload: () => reloads++,
        onPreloadError: (listener) => (firstFailure = listener),
      },
    )

    const firstPreventDefault = vi.fn()
    firstFailure({ preventDefault: firstPreventDefault })
    expect(reloads).toBe(1)
    expect(firstPreventDefault).toHaveBeenCalledOnce()

    let retryFailure = (_event: Pick<Event, 'preventDefault'>) => {}
    installStaleChunkRecovery(
      { state: { initialized: false, errors: null }, subscribe: () => () => {} },
      {
        storage,
        reload: () => reloads++,
        onPreloadError: (listener) => (retryFailure = listener),
      },
    )
    const retryPreventDefault = vi.fn()
    retryFailure({ preventDefault: retryPreventDefault })

    expect(reloads).toBe(1)
    expect(retryPreventDefault).not.toHaveBeenCalled()
  })

  it('surfaces the preload error when storage cannot guard against a reload loop', () => {
    const storage = {
      getItem: () => {
        throw new Error('storage denied')
      },
      setItem: () => {
        throw new Error('storage denied')
      },
      removeItem: () => {
        throw new Error('storage denied')
      },
    }
    let failure = (_event: Pick<Event, 'preventDefault'>) => {}
    const reload = vi.fn()

    expect(() =>
      installStaleChunkRecovery(
        { state: { initialized: false, errors: null }, subscribe: () => () => {} },
        { storage, reload, onPreloadError: (listener) => (failure = listener) },
      ),
    ).not.toThrow()

    const preventDefault = vi.fn()
    failure({ preventDefault })
    expect(reload).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })
})
