import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_MIGRATIONS_MANIFEST,
  applyAppMigrationPlan,
  planAppMigrations,
  readAppliedAppMigrations,
} from '../app-migrations'

const MIGRATION_ID = '2026-08-worker-owned-not-found'

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ds-app-migrations-')))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), contents)
  }
  execFileSync('git', ['add', '-A'], { cwd: dir })
  repo = dir
  return dir
}

function read(dir: string, path: string): string {
  return readFileSync(join(dir, path), 'utf-8')
}

describe('worker-owned not_found migration', () => {
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

    expect(readAppliedAppMigrations(dir)).toEqual([MIGRATION_ID])
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
    ])
    expect(plan.changedFiles).toEqual([APP_MIGRATIONS_MANIFEST])

    applyAppMigrationPlan(dir, plan)
    expect(readAppliedAppMigrations(dir)).toEqual([MIGRATION_ID])
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

describe('migration manifest', () => {
  it('preserves migration ids written by a newer CLI', () => {
    const dir = makeRepo({ 'wrangler.toml': OLD_WRANGLER })
    writeFileSync(join(dir, APP_MIGRATIONS_MANIFEST), '["2027-01-future"]\n')

    applyAppMigrationPlan(dir, planAppMigrations(dir))

    expect(readAppliedAppMigrations(dir)).toEqual(['2027-01-future', MIGRATION_ID])
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
