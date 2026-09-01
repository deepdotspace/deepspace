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

describe('worker error handler', () => {
  // Nothing type-checks or executes the template's worker.ts in this repo, so
  // the wiring is pinned at the source level: dropping the handler would run
  // Hono's default `console.error(err)`, whose message Workers Logs drops.
  // The handler's own contract (HTTPException responses kept, string-logged
  // 500s for the rest) lives in the SDK's workerErrorHandler and is pinned by
  // packages/deepspace/src/server/__tests__/worker-error.test.ts.
  it('registers the SDK onError handler', () => {
    const worker = readFileSync(
      fileURLToPath(new URL('../../templates/base/worker.ts', import.meta.url)),
      'utf8',
    )
    expect(worker).toContain("app.onError(workerErrorHandler('error'))")
    expect(worker).toMatch(/import \{[^}]*\bworkerErrorHandler\b[^}]*\} from 'deepspace\/worker'/)
  })
})

describe('base scaffold API 404 guard', () => {
  const routes = readFileSync(
    fileURLToPath(new URL('../../templates/base/src/server/http-routes.ts', import.meta.url)),
    'utf8',
  )

  it('answers an unmatched /api call with JSON on every method, not just GET', () => {
    // A GET-only guard let a POST to a mistyped or rolled-back API route fall
    // through to Hono's plain-text 404 — the "text parsed as JSON" failure the
    // guard's own comment says must never happen.
    const guard = routes.slice(routes.indexOf('export function registerStaticRoutes'))
    const methodAgnostic = guard.indexOf("app.all('*'")
    const assetFallback = guard.indexOf("app.get('*'")
    expect(methodAgnostic).toBeGreaterThan(-1)
    expect(methodAgnostic).toBeLessThan(assetFallback)
    expect(guard).toContain("return c.json({ error: 'not_found' }, 404)")
  })

  it('keeps the prefix test in one place rather than re-checking it per method', () => {
    const assetFallback = routes.slice(routes.indexOf("app.get('*'"))
    expect(assetFallback).not.toContain('API_PREFIXES')
  })
})

describe('base scaffold toast viewport', () => {
  const toast = readFileSync(
    fileURLToPath(new URL('../../templates/base/src/components/ui/Toast.tsx', import.meta.url)),
    'utf8',
  )

  it('does not intercept clicks on the page underneath it', () => {
    // The viewport is a fixed z-100 layer over one corner of every page; without
    // this it swallowed real clicks for the lifetime of every toast.
    expect(toast).toContain('pointer-events-none fixed z-[100]')
  })

  it('still lets each toast take its own clicks, so dismiss works', () => {
    expect(toast.slice(toast.indexOf('function ToastItem'))).toContain('pointer-events-auto')
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
