import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { gitFixture } from '../../../__tests__/git-fixture'
import {
  APP_MIGRATIONS_MANIFEST,
  applyAppMigrationPlan,
  planAppMigrations,
  readAppliedAppMigrations,
} from '../app-migrations'

const MIGRATION_ID = '2026-08-worker-owned-not-found'
const IDENTITY_MIGRATION_ID = '2026-08-secure-room-boundaries'
const TEMPLATE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../create-deepspace/templates/base',
)

/** The fallback the 0.13 scaffold shipped, verbatim. */
const OLD_FALLBACK = `export function registerStaticRoutes(app: Hono<AppContext>): void {
  app.get('*', async (c) => {
    const url = new URL(c.req.url)
    if (matches(url.pathname, API_PREFIXES)) {
      return c.json({ error: 'not_found' }, 404)
    }
    const response = await c.env.ASSETS.fetch(c.req.raw)
    if (response.status === 404) {
      if (matches(url.pathname, AGENT_PREFIXES)) {
        return c.json({ error: 'not_found' }, 404)
      }
      url.pathname = '/index.html'
      return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw))
    }
    return response
  })
}
`

const OLD_WRANGLER = `name = "demo"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
`

let repo: string | undefined
let outside: string | undefined

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
  if (outside) rmSync(outside, { recursive: true, force: true })
  repo = undefined
  outside = undefined
})

/** A git checkout holding `files`, since the planner walks tracked paths. */
function makeRepo(files: Record<string, string>): string {
  const dir = gitFixture({ files, add: true })
  repo = dir
  return dir
}

function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), 'utf-8')
}

describe('worker-owned not_found migration', () => {
  it('recognizes the current secure scaffold without migration stamps', () => {
    const dir = makeRepo({
      'wrangler.toml': readFileSync(join(TEMPLATE_ROOT, 'wrangler.toml'), 'utf8'),
      'worker.ts': readFileSync(join(TEMPLATE_ROOT, 'worker.ts'), 'utf8'),
      'src/server/http-routes.ts': readFileSync(
        join(TEMPLATE_ROOT, 'src/server/http-routes.ts'),
        'utf8',
      ),
      'src/server/realtime-routes.ts': readFileSync(
        join(TEMPLATE_ROOT, 'src/server/realtime-routes.ts'),
        'utf8',
      ),
    })

    const plan = planAppMigrations(dir)
    expect(plan.blockers).toEqual([])
    expect(plan.pending).toEqual([
      expect.objectContaining({ id: MIGRATION_ID, files: [], replacements: 0 }),
      expect.objectContaining({ id: IDENTITY_MIGRATION_ID, files: [], replacements: 0 }),
    ])
    expect(plan.changedFiles).toEqual([APP_MIGRATIONS_MANIFEST])
  })

  it('carries a stock 0.13 app to worker-owned misses', () => {
    const dir = makeRepo({
      'wrangler.toml': OLD_WRANGLER,
      'src/server/http-routes.ts': OLD_FALLBACK,
    })

    const plan = planAppMigrations(dir)
    expect(plan.blockers).toEqual([])
    expect(plan.pending).toEqual([
      expect.objectContaining({
        id: MIGRATION_ID,
        files: ['src/server/http-routes.ts', 'wrangler.toml'],
        // toml handling + fallback target + inserted guard
        replacements: 3,
      }),
      expect.objectContaining({
        id: IDENTITY_MIGRATION_ID,
        files: [],
        replacements: 0,
      }),
    ])

    applyAppMigrationPlan(dir, plan)

    expect(read(dir, 'wrangler.toml')).toContain('not_found_handling = "none"')
    const worker = read(dir, 'src/server/http-routes.ts')
    // The shell is requested at '/' — '/index.html' redirects there and drops
    // the browser off the deep link it asked for.
    expect(worker).toContain("url.pathname = '/'")
    expect(worker).not.toContain("'/index.html'")
    // ...and a file-like miss 404s before reaching that fallback.
    expect(worker).toContain(
      "if (url.pathname.slice(url.pathname.lastIndexOf('/') + 1).includes('.')) {",
    )
    expect(worker.indexOf('.includes(')).toBeLessThan(worker.indexOf("url.pathname = '/'"))
    // Indentation follows the line it guards, so the file still parses as it reads.
    expect(worker).toContain(
      "      if (url.pathname.slice(url.pathname.lastIndexOf('/') + 1).includes('.')) {\n" +
        "        return c.json({ error: 'not_found' }, 404)\n" +
        '      }\n',
    )

    expect(readAppliedAppMigrations(dir)).toEqual([MIGRATION_ID, IDENTITY_MIGRATION_ID])
    expect(planAppMigrations(dir).pending).toEqual([])
  })

  it('is a no-op on an app already carrying the current shape', () => {
    const dir = makeRepo({
      'wrangler.toml': OLD_WRANGLER.replace('single-page-application', 'none'),
      'src/server/http-routes.ts': `const response = await c.env.ASSETS.fetch(c.req.raw)
if (response.status !== 404) return response
if (namesAFile(url.pathname) || isPlatformReservedPath(url.pathname)) {
  return c.json({ error: 'not_found' }, 404)
}
url.pathname = '/'
`,
    })

    const plan = planAppMigrations(dir)
    expect(plan.blockers).toEqual([])
    expect(plan.pending).toEqual([
      expect.objectContaining({ id: MIGRATION_ID, files: [], replacements: 0 }),
      expect.objectContaining({ id: IDENTITY_MIGRATION_ID, files: [], replacements: 0 }),
    ])
    expect(plan.changedFiles).toEqual([APP_MIGRATIONS_MANIFEST])

    applyAppMigrationPlan(dir, plan)
    expect(readAppliedAppMigrations(dir)).toEqual([MIGRATION_ID, IDENTITY_MIGRATION_ID])
  })

  it('applies its edits and reports the rest when a fallback is hand-rolled', () => {
    const dir = makeRepo({
      'wrangler.toml': OLD_WRANGLER,
      'src/server/http-routes.ts': `const shell = new URL('/index.html', c.req.url)
const response = await c.env.ASSETS.fetch(c.req.raw)
if (response.status === 404) return c.env.ASSETS.fetch(shell)
`,
    })

    const plan = planAppMigrations(dir)
    expect(plan.blockers).toEqual([
      expect.objectContaining({
        migrationId: MIGRATION_ID,
        file: 'src/server/http-routes.ts',
        line: 1,
        message: expect.stringContaining('redirects to "/"'),
      }),
    ])

    // The half it CAN do still lands: refusing everything would leave the app
    // on the old behavior for the sake of an edit the author has to make.
    applyAppMigrationPlan(dir, plan)
    expect(read(dir, 'wrangler.toml')).toContain('not_found_handling = "none"')

    // ...but the migration is not recorded, so `update` asks again.
    expect(readAppliedAppMigrations(dir)).toEqual([])
    expect(planAppMigrations(dir).blockers).toHaveLength(1)
  })

  it('does not mistake a build config naming ./index.html for a worker fallback', () => {
    const dir = makeRepo({
      'wrangler.toml': OLD_WRANGLER,
      'vite.config.ts': `// ASSETS are emitted next to it
export default { optimizeDeps: { entries: ['./index.html'] } }
`,
    })
    expect(planAppMigrations(dir).blockers).toEqual([])
  })

  it('leaves untracked files alone', () => {
    const dir = makeRepo({ 'wrangler.toml': OLD_WRANGLER })
    writeFileSync(join(dir, 'scratch.ts'), `url.pathname = '/index.html'\n`)

    const plan = planAppMigrations(dir)
    expect(plan.changedFiles).toEqual([APP_MIGRATIONS_MANIFEST, 'wrangler.toml'])
    applyAppMigrationPlan(dir, plan)
    expect(read(dir, 'scratch.ts')).toContain("'/index.html'")
  })
})

const LEGACY_REALTIME_ROUTES = `import { verifyJwt } from 'deepspace/worker'

const IDENTITY_QUERY_PARAMS = ['userId', 'userName', 'userEmail', 'userImageUrl', 'role'] as const

function authenticatedRoomUrl(
  requestUrl: string,
  auth: VerifyResult | null,
  extraParams?: (auth: VerifyResult) => Record<string, string>,
): URL {
  const doUrl = new URL(requestUrl)
  doUrl.searchParams.delete('token')
  for (const key of IDENTITY_QUERY_PARAMS) {
    doUrl.searchParams.delete(key)
  }

  if (!auth) return doUrl

  doUrl.searchParams.set('userId', auth.userId)
  if (auth.claims.name) doUrl.searchParams.set('userName', auth.claims.name)
  if (auth.claims.email) doUrl.searchParams.set('userEmail', auth.claims.email)
  if (auth.claims.image) doUrl.searchParams.set('userImageUrl', auth.claims.image)
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams(auth))) {
      doUrl.searchParams.set(key, value)
    }
  }
  return doUrl
}

function wsRoute(
  doNamespace: (env: Env) => DurableObjectNamespace,
  extraParams?: (auth: VerifyResult) => Record<string, string>,
) {
  return async (c: Context<AppContext>) => {
    const doUrl = authenticatedRoomUrl(c.req.url, auth, extraParams)
    const stub = doNamespace(c.env).get('room')
    return stub.fetch(new Request(doUrl.toString(), c.req.raw))
  }
}

async function yjs(c: Context<AppContext>, auth: VerifyResult, role: string) {
    const doUrl = authenticatedRoomUrl(c.req.url, auth, () => ({ role }))
    const stub = c.env.YJS_ROOMS.get('doc')
    return stub.fetch(new Request(doUrl.toString(), c.req.raw))
}
`

describe('internal identity header migration', () => {
  it('atomically carries a stock room proxy from URL identity to headers', () => {
    const dir = makeRepo({
      [APP_MIGRATIONS_MANIFEST]: `${JSON.stringify([MIGRATION_ID])}\n`,
      'src/server/realtime-routes.ts': LEGACY_REALTIME_ROUTES,
    })

    const plan = planAppMigrations(dir)
    expect(plan.blockers).toEqual([])
    expect(plan.pending).toEqual([
      expect.objectContaining({
        id: IDENTITY_MIGRATION_ID,
        files: ['src/server/realtime-routes.ts'],
        replacements: 7,
      }),
    ])

    applyAppMigrationPlan(dir, plan)
    const migrated = read(dir, 'src/server/realtime-routes.ts')
    expect(migrated).toContain(
      "import { authenticatedRoomRequest, verifyJwt } from 'deepspace/worker'",
    )
    expect(migrated).not.toContain('function authenticatedRoomRequest(')
    expect(migrated).toContain('const roomRequest = authenticatedRoomRequest(')
    expect(migrated).toContain('return stub.fetch(roomRequest)')
    expect(migrated).not.toContain("doUrl.searchParams.set('userId'")
    expect(readAppliedAppMigrations(dir)).toEqual([MIGRATION_ID, IDENTITY_MIGRATION_ID])
  })

  it('reports one precise blocker rather than half-rewriting a customized proxy', () => {
    const customized = LEGACY_REALTIME_ROUTES.replace(
      'return stub.fetch(new Request(doUrl.toString(), c.req.raw))',
      'return instrument(stub.fetch(new Request(doUrl.toString(), c.req.raw)))',
    )
    const dir = makeRepo({
      [APP_MIGRATIONS_MANIFEST]: `${JSON.stringify([MIGRATION_ID])}\n`,
      'src/server/realtime-routes.ts': customized,
    })

    const plan = planAppMigrations(dir)
    expect(plan.pending).toEqual([
      expect.objectContaining({ id: IDENTITY_MIGRATION_ID, replacements: 0 }),
    ])
    expect(plan.blockers).toEqual([
      expect.objectContaining({
        migrationId: IDENTITY_MIGRATION_ID,
        file: 'src/server/realtime-routes.ts',
        message: expect.stringContaining('authenticatedRoomRequest()'),
      }),
    ])
    expect(plan.edits).toEqual([])
  })

  it('does not stamp a mixed proxy that has a new helper but retains a legacy path', () => {
    const dir = makeRepo({
      [APP_MIGRATIONS_MANIFEST]: `${JSON.stringify([MIGRATION_ID])}\n`,
      'src/server/realtime-routes.ts':
        'function authenticatedRoomRequest() {}\n' + LEGACY_REALTIME_ROUTES,
    })

    const plan = planAppMigrations(dir)
    expect(plan.pending).toEqual([
      expect.objectContaining({ id: IDENTITY_MIGRATION_ID, replacements: 0 }),
    ])
    expect(plan.blockers).toEqual([expect.objectContaining({ migrationId: IDENTITY_MIGRATION_ID })])
    expect(plan.edits).toEqual([])
  })

  it('blocks a customized role-only URL identity path', () => {
    const dir = makeRepo({
      [APP_MIGRATIONS_MANIFEST]: `${JSON.stringify([MIGRATION_ID])}\n`,
      'src/server/realtime-routes.ts': `function authenticatedRoomRequest() {}
const doUrl = new URL(c.req.url)
doUrl.searchParams.append('role', auth.claims.role)
return stub.fetch(new Request(doUrl.toString(), c.req.raw))
`,
    })

    const plan = planAppMigrations(dir)
    expect(plan.pending).toEqual([
      expect.objectContaining({ id: IDENTITY_MIGRATION_ID, replacements: 0 }),
    ])
    expect(plan.blockers).toEqual([
      expect.objectContaining({ migrationId: IDENTITY_MIGRATION_ID, line: 3 }),
    ])
    expect(plan.edits).toEqual([])
  })

  it('blocks renamed proxies that inject verified identity through dynamic query keys', () => {
    const dir = makeRepo({
      [APP_MIGRATIONS_MANIFEST]: `${JSON.stringify([MIGRATION_ID])}\n`,
      'src/server/realtime-routes.ts': `function customRoomRequest(auth: VerifyResult) {
  const target = new URL(c.req.url)
  const identity = { userId: auth.userId }
  for (const [key, value] of Object.entries(identity)) target.searchParams.set(key, value)
  const forwarded = new Request(target.toString(), c.req.raw)
  return stub.fetch(forwarded)
}
`,
    })

    const plan = planAppMigrations(dir)
    expect(plan.pending).toEqual([
      expect.objectContaining({ id: IDENTITY_MIGRATION_ID, replacements: 0 }),
    ])
    expect(plan.blockers).toEqual([
      expect.objectContaining({ migrationId: IDENTITY_MIGRATION_ID, line: 4 }),
    ])
    expect(plan.edits).toEqual([])
  })

  it('adds stock job-role and owner/admin debug gates using the SDK role resolver', () => {
    const dir = makeRepo({
      [APP_MIGRATIONS_MANIFEST]: `${JSON.stringify([MIGRATION_ID])}\n`,
      'src/server/realtime-routes.ts': `function authenticatedRoomRequest() {}
`,
      'worker.ts': `import type { DOBindings, DOManifest, Job, JobContext } from 'deepspace/worker'
export class AppJobRoom extends JobRoom<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
  }
}
`,
      'src/server/http-routes.ts': `import type { AppContext, Env } from '../../worker.js'
export function registerAuthAndIntegrationRoutes(app: Hono<AppContext>): void {
  app.all('/api/debug/*', async (c) => {
    if (c.env.ALLOW_DEBUG_ROUTES !== 'true') {
      return c.notFound()
    }
    const stub = c.env.RECORD_ROOMS.get(
      c.env.RECORD_ROOMS.idFromName('app:test'),
    )
    return stub.fetch(c.req.raw)
  })
}
`,
    })

    const plan = planAppMigrations(dir)
    expect(plan.blockers).toEqual([])
    expect(plan.pending).toEqual([
      expect.objectContaining({
        id: IDENTITY_MIGRATION_ID,
        files: ['src/server/http-routes.ts', 'worker.ts'],
        replacements: 4,
      }),
    ])

    applyAppMigrationPlan(dir, plan)
    expect(read(dir, 'src/server/realtime-routes.ts')).not.toContain('resolveAppRole')
    expect(read(dir, 'worker.ts')).toContain("import { resolveAppRole } from 'deepspace/worker'")
    expect(read(dir, 'worker.ts')).toContain('authorizeWrite: async (user) =>')
    const http = read(dir, 'src/server/http-routes.ts')
    expect(http).toContain("import { resolveAppRole } from 'deepspace/worker'")
    expect(http).toContain("if (!auth) return c.json({ error: 'unauthorized' }, 401)")
    expect(http).toContain("(await resolveAppRole(c.env, auth.userId)) !== 'admin'")
    expect(readAppliedAppMigrations(dir)).toEqual([MIGRATION_ID, IDENTITY_MIGRATION_ID])
  })

  it.each(["'", '"'] as const)(
    'does not certify a live %s-quoted unsafe debug route from a commented secure handler',
    (quote) => {
      const dir = makeRepo({
        [APP_MIGRATIONS_MANIFEST]: `${JSON.stringify([MIGRATION_ID])}\n`,
        'src/server/http-routes.ts': `import type { AppContext, Env } from '../../worker.js'
/*
import { resolveAppRole } from 'deepspace/worker'
  app.all('/api/debug/*', async (c) => {
    if (c.env.ALLOW_DEBUG_ROUTES !== 'true') {
      return c.notFound()
    }
    const auth = await resolveAuth(c.req.raw, c.env)
    if (!auth) return c.json({ error: 'unauthorized' }, 401)
    if ((await resolveAppRole(c.env, auth.userId)) !== 'admin') {
      return c.json({ error: 'forbidden' }, 403)
    }
    const stub = c.env.RECORD_ROOMS.get(c.env.RECORD_ROOMS.idFromName('commented'))
  })
*/
export function registerAuthAndIntegrationRoutes(app: Hono<AppContext>): void {
  app.all(${quote}/api/debug/*${quote}, async (c) => {
    if (c.env.ALLOW_DEBUG_ROUTES !== 'true') {
      return c.notFound()
    }
    const stub = c.env.RECORD_ROOMS.get(c.env.RECORD_ROOMS.idFromName('live'))
    return stub.fetch(c.req.raw)
  })
}
`,
      })

      const plan = planAppMigrations(dir)
      expect(plan.pending).toEqual([
        expect.objectContaining({ id: IDENTITY_MIGRATION_ID, replacements: 0 }),
      ])
      expect(plan.blockers).toEqual([
        expect.objectContaining({
          migrationId: IDENTITY_MIGRATION_ID,
          file: 'src/server/http-routes.ts',
        }),
      ])
      expect(plan.edits).toEqual([])
    },
  )

  it('blocks a customized JobRoom authorizer instead of stamping source-wide keywords', () => {
    const dir = makeRepo({
      [APP_MIGRATIONS_MANIFEST]: `${JSON.stringify([MIGRATION_ID])}\n`,
      'worker.ts': `import { resolveAppRole } from 'deepspace/worker'
const unrelated = resolveAppRole
export class AppJobRoom extends JobRoom<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, {
      authorizeWrite: async (user) => !user.userId.startsWith('anon-'),
    })
  }
}
`,
    })

    const plan = planAppMigrations(dir)
    expect(plan.pending).toEqual([
      expect.objectContaining({ id: IDENTITY_MIGRATION_ID, replacements: 0 }),
    ])
    expect(plan.blockers).toEqual([
      expect.objectContaining({
        migrationId: IDENTITY_MIGRATION_ID,
        file: 'worker.ts',
      }),
    ])
    expect(plan.edits).toEqual([])
  })

  it.each([
    [
      'a sibling class',
      `export class SiblingJobRoom extends JobRoom<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, {
      authorizeWrite: async (user) => {
        if (user.userId.startsWith('anon-')) return false
        const role = await resolveAppRole(env, user.userId)
        return role === 'member' || role === 'admin'
      },
    })
  }
}`,
    ],
    [
      'a commented stock block',
      `/*
export class AppJobRoom extends JobRoom<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, {
      authorizeWrite: async (user) => {
        if (user.userId.startsWith('anon-')) return false
        const role = await resolveAppRole(env, user.userId)
        return role === 'member' || role === 'admin'
      },
    })
  }
}
*/`,
    ],
  ])('does not certify an unsafe AppJobRoom from %s', (_label, misleadingSource) => {
    const dir = makeRepo({
      [APP_MIGRATIONS_MANIFEST]: `${JSON.stringify([MIGRATION_ID])}\n`,
      'worker.ts': `import { resolveAppRole } from 'deepspace/worker'
${misleadingSource}
export class AppJobRoom extends JobRoom<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, {
      authorizeWrite: async () => true,
    })
  }
}
`,
    })

    const plan = planAppMigrations(dir)
    expect(plan.blockers).toEqual([
      expect.objectContaining({ migrationId: IDENTITY_MIGRATION_ID, file: 'worker.ts' }),
    ])
    expect(plan.edits).toEqual([])
  })

  it('does not certify a custom class declaration from a commented stock block', () => {
    const dir = makeRepo({
      [APP_MIGRATIONS_MANIFEST]: `${JSON.stringify([MIGRATION_ID])}\n`,
      'worker.ts': `import { resolveAppRole } from 'deepspace/worker'
/*
export class AppJobRoom extends JobRoom<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, {
      authorizeWrite: async (user) => {
        if (user.userId.startsWith('anon-')) return false
        const role = await resolveAppRole(env, user.userId)
        return role === 'member' || role === 'admin'
      },
    })
  }
}
*/
export default class AppJobRoom extends JobRoom<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, { authorizeWrite: async () => true })
  }
}
`,
    })

    const plan = planAppMigrations(dir)
    expect(plan.blockers).toEqual([
      expect.objectContaining({ migrationId: IDENTITY_MIGRATION_ID, file: 'worker.ts' }),
    ])
    expect(plan.edits).toEqual([])
  })
})

describe('migration manifest', () => {
  it('preserves migration ids written by a newer CLI', () => {
    const dir = makeRepo({ 'wrangler.toml': OLD_WRANGLER })
    writeFileSync(join(dir, APP_MIGRATIONS_MANIFEST), '["2027-01-future"]\n')

    applyAppMigrationPlan(dir, planAppMigrations(dir))

    expect(readAppliedAppMigrations(dir)).toEqual([
      '2027-01-future',
      MIGRATION_ID,
      IDENTITY_MIGRATION_ID,
    ])
  })

  it('rejects a malformed migration manifest', () => {
    const dir = makeRepo({ 'wrangler.toml': OLD_WRANGLER })
    writeFileSync(join(dir, APP_MIGRATIONS_MANIFEST), '{not json}\n')
    expect(() => planAppMigrations(dir)).toThrow('must contain valid JSON')
  })

  it('rejects a tracked manifest symlink without reading its target', () => {
    const dir = makeRepo({ 'wrangler.toml': OLD_WRANGLER })
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'ds-app-migrations-outside-')))
    const target = join(outside, 'external.json')
    writeFileSync(target, '[]\n')
    symlinkSync(target, join(dir, APP_MIGRATIONS_MANIFEST))
    execFileSync('git', ['add', APP_MIGRATIONS_MANIFEST], { cwd: dir })

    expect(() => planAppMigrations(dir)).toThrow('must be a regular file, not a symlink')
    expect(readFileSync(target, 'utf-8')).toBe('[]\n')
  })

  it('does not follow a manifest symlink introduced after planning', () => {
    const dir = makeRepo({ 'wrangler.toml': OLD_WRANGLER })
    const plan = planAppMigrations(dir)
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'ds-app-migrations-outside-')))
    const target = join(outside, 'external.json')
    writeFileSync(target, '[]\n')
    symlinkSync(target, join(dir, APP_MIGRATIONS_MANIFEST))

    expect(() => applyAppMigrationPlan(dir, plan)).toThrow('must be a regular file, not a symlink')
    expect(readFileSync(target, 'utf-8')).toBe('[]\n')
    expect(read(dir, 'wrangler.toml')).toContain('single-page-application')
  })

  it('refuses to write content planned against a since-edited file', () => {
    const dir = makeRepo({ 'wrangler.toml': OLD_WRANGLER })
    const plan = planAppMigrations(dir)
    writeFileSync(join(dir, 'wrangler.toml'), `${OLD_WRANGLER}# edited after planning\n`)

    expect(() => applyAppMigrationPlan(dir, plan)).toThrow('changed after planning')
  })
})

/**
 * Line endings are a property of the CHECKOUT, not of the app.
 *
 * Git for Windows sets `core.autocrlf=true` system-wide and scaffolded apps
 * ship no `.gitattributes`, so every Windows clone lands CRLF. The seams are LF
 * template literals matched by exact substring, so a CRLF tree once declined
 * every multi-line migration AND reported the untouched file as customized.
 *
 * Parametrized rather than written twice so it covers every migration added to
 * SOURCE_MIGRATIONS from here on. Bytes are written directly, so this proves
 * the behaviour on ordinary Linux CI — no Windows runner required.
 */
describe.each([
  ['LF', '\n'],
  ['CRLF', '\r\n'],
])('a %s working tree migrates identically', (_label, eol) => {
  const withEol = (source: string): string => source.replaceAll('\n', eol)

  /** A stock 0.18 app: both room-boundary seams present, neither secured. */
  const stockApp = (): Record<string, string> => ({
    [APP_MIGRATIONS_MANIFEST]: withEol(`${JSON.stringify([MIGRATION_ID])}\n`),
    'src/server/realtime-routes.ts': withEol(`function authenticatedRoomRequest() {}\n`),
    'worker.ts': withEol(`import type { DOBindings, DOManifest, Job, JobContext } from 'deepspace/worker'
export class AppJobRoom extends JobRoom<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
  }
}
`),
    'src/server/http-routes.ts': withEol(`import type { AppContext, Env } from '../../worker.js'
export function registerAuthAndIntegrationRoutes(app: Hono<AppContext>): void {
  app.all('/api/debug/*', async (c) => {
    if (c.env.ALLOW_DEBUG_ROUTES !== 'true') {
      return c.notFound()
    }
    const stub = c.env.RECORD_ROOMS.get(
      c.env.RECORD_ROOMS.idFromName('app:test'),
    )
    return stub.fetch(c.req.raw)
  })
}
`),
  })

  it('plans the same edits and reports no blockers', () => {
    const plan = planAppMigrations(makeRepo(stockApp()))

    expect(plan.blockers).toEqual([])
    expect(plan.pending).toEqual([
      expect.objectContaining({
        id: IDENTITY_MIGRATION_ID,
        files: ['src/server/http-routes.ts', 'worker.ts'],
        replacements: 4,
      }),
    ])
  })

  it('applies the guards and leaves the file in ONE line-ending style', () => {
    const dir = makeRepo(stockApp())
    applyAppMigrationPlan(dir, planAppMigrations(dir))

    const worker = read(dir, 'worker.ts')
    expect(worker).toContain('authorizeWrite: async (user) =>')
    // The inserted lines must adopt the file's endings — a migration that
    // splices LF into a CRLF file leaves a mixed-ending file behind.
    expect(worker.split(eol).join('')).not.toMatch(/[\r\n]/)
  })

  it('re-planning after apply finds nothing left to do', () => {
    const dir = makeRepo(stockApp())
    applyAppMigrationPlan(dir, planAppMigrations(dir))

    const replan = planAppMigrations(dir)
    expect(replan.changedFiles).toEqual([])
    expect(replan.blockers).toEqual([])
    expect(readAppliedAppMigrations(dir)).toContain(IDENTITY_MIGRATION_ID)
  })
})
