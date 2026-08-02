import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  matchAppSelector,
  parseAppArg,
  resolveAppSelector,
  resolveAppTarget,
  requireAppIdArg,
} from '../app-target'

/** The machine `code` a thrown value carries (InputError/ApiError), or undefined. */
const thrownCode = (fn: () => unknown): unknown => {
  try {
    fn()
  } catch (e) {
    return (e as { code?: unknown }).code
  }
  return undefined
}

describe('parseAppArg', () => {
  // Live-test finding: `args.app?.trim() || undefined` treated an explicitly
  // blank --app the same as no --app, so a MUTATING command (push/deploy) could
  // silently target the surrounding directory's app instead of erroring.
  it('treats an absent flag as "use the current directory\'s app"', () => {
    expect(parseAppArg(undefined)).toEqual({})
  })

  it('rejects an explicitly blank/whitespace value instead of falling back to the current app', () => {
    for (const bad of ['', '   ', '\t', '\n']) {
      expect(parseAppArg(bad).error, JSON.stringify(bad)).toBeTruthy()
      expect(parseAppArg(bad).app, JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('returns a valid selector, trimmed of surrounding whitespace', () => {
    expect(parseAppArg('app_01ARZ3NDEKTSV4RRFFQ69G5FAV')).toEqual({
      app: 'app_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    })
    expect(parseAppArg('  my-app  ')).toEqual({ app: 'my-app' })
  })

  it('rejects a malformed non-blank selector (not app_<ULID> or a subdomain name) client-side', () => {
    // parseAppArg now format-validates against APP_ID_RE so a malformed selector
    // fails pre-auth instead of round-tripping to the registry as a bad name.
    expect(parseAppArg('my app').error).toMatch(/not a valid app id or name/)
    expect(parseAppArg('Bad Name!').error).toBeTruthy()
    // A valid strict id and a valid subdomain name still pass through.
    expect(parseAppArg('app_01ARZ3NDEKTSV4RRFFQ69G5FAV')).toEqual({
      app: 'app_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    })
    expect(parseAppArg('my-app-123')).toEqual({ app: 'my-app-123' })
  })

  it('accepts only canonical app names', () => {
    // The subdomain-name arm is a DNS label; APP_ID_RE's older name pattern let
    // `_` and a trailing `-` through, so these reached auth as not_authenticated
    // instead of being refused client-side. All must fail as invalid_app pre-auth.
    for (const bad of ['foo_bar', 'a_b', 'app-', '-app', 'app.b', 'a', 'app--double']) {
      expect(parseAppArg(bad).error, bad).toMatch(/not a valid app id or name/)
      expect(parseAppArg(bad).app, bad).toBeUndefined()
    }
    // An `app_`-prefixed typo is reported as a bad id, not a bad name.
    expect(parseAppArg('app_bad').error).toMatch(/isn't a valid app_<ULID>/)
    // Legitimate DNS-label names still resolve.
    for (const ok of ['my-app', 'app', 'x1', 'a-b-c-1']) {
      expect(parseAppArg(ok), ok).toEqual({ app: ok })
    }
  })
})

describe('--app blank guard wiring (throws code:"invalid_app" before any fs/network)', () => {
  // The blank branch of each resolver throws BEFORE findAppDir/resolveAppSelector/
  // detectAppName, so these need no fs or network — they lock the parseAppArg →
  // InputError('invalid_app') join for all three --app entry points.
  it('resolveAppTarget rejects an explicit blank with code invalid_app', async () => {
    await expect(resolveAppTarget('http://x', 'tok', '   ')).rejects.toMatchObject({
      code: 'invalid_app',
    })
    await expect(resolveAppTarget('http://x', 'tok', '')).rejects.toMatchObject({
      code: 'invalid_app',
    })
  })

  it('requireAppIdArg (transfer accept) rejects an explicit blank with code invalid_app', () => {
    expect(thrownCode(() => requireAppIdArg('   '))).toBe('invalid_app')
    expect(thrownCode(() => requireAppIdArg(''))).toBe('invalid_app')
  })

})

describe('matchAppSelector', () => {
  const apps = [
    { appId: 'app_00000000000000000000000001', name: 'coolapp' },
    { appId: 'app_00000000000000000000000002', name: null },
    { appId: 'legacyapp', name: 'legacyapp' },
  ]

  it('matches ids and live names', () => {
    expect(matchAppSelector(apps, 'app_00000000000000000000000001')).toBe(
      'app_00000000000000000000000001',
    )
    expect(matchAppSelector(apps, 'coolapp')).toBe('app_00000000000000000000000001')
    expect(matchAppSelector(apps, 'legacyapp')).toBe('legacyapp')
  })

  it('passes through strict ids and rejects unknown names', () => {
    expect(matchAppSelector(apps, 'app_ZZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(
      'app_ZZZZZZZZZZZZZZZZZZZZZZZZZZ',
    )
    expect(matchAppSelector(apps, 'nope')).toBeNull()
  })
})

describe('resolveAppSelector', () => {
  const owned = { appId: 'app_00000000000000000000000001', name: 'coolapp' }

  afterEach(() => vi.unstubAllGlobals())

  function stubFetch(handlers: Record<string, { status: number; body: unknown }>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const path = new URL(String(url)).pathname
        const hit = handlers[path]
        if (!hit) throw new Error(`unexpected fetch: ${path}`)
        return new Response(JSON.stringify(hit.body), { status: hit.status })
      }),
    )
  }

  it('resolves an owned name from the app list', async () => {
    stubFetch({ '/api/apps': { status: 200, body: { apps: [owned] } } })
    await expect(resolveAppSelector('https://deploy.test', 'tok', 'coolapp')).resolves.toBe(
      owned.appId,
    )
  })

  it('uses the access-gated resolver for collaborator apps', async () => {
    stubFetch({
      '/api/apps': { status: 200, body: { apps: [owned] } },
      '/api/repo/resolve-name/shared-app': {
        status: 200,
        body: { appId: 'app_00000000000000000000000002' },
      },
    })
    await expect(resolveAppSelector('https://deploy.test', 'tok', 'shared-app')).resolves.toBe(
      'app_00000000000000000000000002',
    )
  })

  it('reports a missing or inaccessible name', async () => {
    stubFetch({
      '/api/apps': { status: 200, body: { apps: [owned] } },
      '/api/repo/resolve-name/ghost': {
        status: 404,
        body: { error: 'No app named "ghost" that you can access', code: 'app_not_found' },
      },
    })
    await expect(resolveAppSelector('https://deploy.test', 'tok', 'ghost')).rejects.toThrow(
      /No app "ghost" found, or you don't have access/,
    )
  })
})
