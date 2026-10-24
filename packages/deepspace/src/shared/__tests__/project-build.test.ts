import { describe, expect, it } from 'vitest'
import {
  identifyProject,
  prepareRawProject,
  projectArtifactForm,
  projectConfig,
  rawProjectConfig,
} from '../project-build'
const id = 'app_01M4Y1HZCX11EFMZZD0EHEQQ1Q'
describe('ordinary raw project publishing', () => {
  it('retains app and SQLite identities while producing the normal deploy wire contract', async () => {
    const config = rawProjectConfig('small-board', id, [
      { binding: 'BOARD', className: 'Board', sqlite: true },
    ])
    const artifact = await prepareRawProject({
      'wrangler.toml': config,
      'worker.js': 'export default {}',
      'lib.js': 'export const ok=true',
      'public/index.html': '<h1>Hello</h1>',
      'public/_headers': '/*\n  X-Test: yes',
    })
    expect(artifact.doManifest).toEqual([{ binding: 'BOARD', className: 'Board', sqlite: true }])
    expect(artifact.assets.map((a) => a.path)).toEqual(['/index.html'])
    const form = projectArtifactForm(artifact)
    expect(form.get('workerMain')).toBe('worker.js')
    expect(JSON.parse(String(form.get('workerModules')))).toEqual(['lib.js'])
    expect(JSON.parse(String(form.get('assetConfig')))).toEqual({ _headers: '/*\n  X-Test: yes' })
    expect(projectConfig(identifyProject(config, 'small-board', id)).vars.DEEPSPACE_APP_ID).toBe(id)
  })
  it('refuses cross-app source and paths outside the project', () => {
    expect(() =>
      identifyProject(rawProjectConfig('a', 'app_01M4Y132CPNAP7BW6Y1GH54QZT'), 'b', id),
    ).toThrow('another app')
    expect(() => projectConfig('main="../outside.js"\n[assets]\ndirectory="public"')).toThrow(
      'inside',
    )
    expect(() => projectConfig('main="worker.js"\n[assets]\ndirectory="/etc"')).toThrow('inside')
  })

  it('explains a missing [assets] table instead of returning a raw schema dump', () => {
    let message = ''
    try {
      identifyProject('name="x"\nmain="src/worker.js"', 'x', id)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('wrangler.toml is not a valid DeepSpace project')
    expect(message).toContain('assets:')
    expect(message).toContain('[assets] directory = "public"')
    expect(message).not.toContain('"code"')
  })
  it('does not accidentally skip building a normal SDK project', async () => {
    await expect(
      prepareRawProject({ 'wrangler.toml': 'main="worker.ts"\n[assets]\ndirectory="dist"' }),
    ).rejects.toThrow('needs a build')
  })
  it('retains other Wrangler settings and accepts false worker-first with empty DO configuration', async () => {
    const config =
      'main="worker.js"\nno_bundle=true\n[build]\ncommand="custom-build"\n[assets]\ndirectory="public"\nrun_worker_first=false\n[durable_objects]'
    const identified = projectConfig(identifyProject(config, 'small-board', id))
    expect(identified.build).toEqual({ command: 'custom-build' })
    const artifact = await prepareRawProject({
      'wrangler.toml': config,
      'worker.js': 'export default {}',
    })
    expect(artifact.extraRoutes).toEqual([])
    expect(artifact.doManifest).toEqual([])
  })
  it.each([
    'compatibility_flags = 123',
    'migrations = ["not-a-table"]',
    '[durable_objects]\nbindings = [{ name = 42, class_name = "Board" }]',
  ])('rejects malformed build fields instead of asserting their types: %s', (field) => {
    expect(() =>
      projectConfig('main="worker.js"\n' + field + '\n[assets]\ndirectory="public"'),
    ).toThrow()
  })
  it('hashes and encodes binary assets without a lossy UTF-8 round trip', async () => {
    const bytes = new Uint8Array([0, 255, 254, 12])
    const artifact = await prepareRawProject({
      'wrangler.toml': rawProjectConfig('binary-app', id),
      'worker.js': 'export default {}',
      'public/favicon.ico': bytes,
    })
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('')
    expect(artifact.assets).toEqual([
      { path: '/favicon.ico', hash, size: bytes.length, base64: 'AP/+DA==' },
    ])
  })
  it.each(['wrangler.toml', 'worker.js', 'public/_headers', 'public/_redirects'])(
    'rejects binary source configuration or modules at %s',
    async (path) => {
      await expect(
        prepareRawProject({
          'wrangler.toml': rawProjectConfig('binary-app', id),
          'worker.js': 'export default {}',
          [path]: new Uint8Array([255]),
        }),
      ).rejects.toThrow('Expected UTF-8 source text: ' + path)
    },
  )
})
