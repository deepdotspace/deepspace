/** Project configuration and ready-to-upload artifacts shared by native and hosted publishing. */
import { parse, stringify } from 'smol-toml'
import { z } from 'zod/v4'
import {
  bindingManifestFromOutputConfig,
  validateBindingManifest,
} from '../server/rooms/binding-manifest'

export interface ProjectArtifact {
  worker: { main: string; modules: Array<{ name: string; content: string }> }
  assets: Array<{ path: string; hash: string; size: number; base64: string }>
  assetConfig: { _headers?: string; _redirects?: string }
  doManifest: Array<{ binding: string; className: string; sqlite: boolean }>
  customBindings: ReturnType<typeof bindingManifestFromOutputConfig>
  appMigrations: string[]
  extraRoutes: true | string[]
  compatibilityDate: string | null
  compatibilityFlags: string[]
  notFoundHandling: string | null
}
// Preserve Wrangler fields owned by the build/deploy pipeline while validating
// the fields this shared raw-project path reads itself.
const projectConfigSchema = z
  .object({
    name: z.string().optional(),
    main: z.string().min(1),
    no_bundle: z.boolean().optional(),
    assets: z
      .object({
        directory: z.string().min(1),
        run_worker_first: z.union([z.boolean(), z.array(z.string())]).optional(),
        not_found_handling: z.string().optional(),
      })
      .passthrough(),
    vars: z.record(z.string(), z.unknown()).default({}),
    migrations: z
      .array(z.object({ new_sqlite_classes: z.array(z.string()).optional() }).passthrough())
      .optional(),
    durable_objects: z
      .object({
        bindings: z
          .array(z.object({ name: z.string().min(1), class_name: z.string().min(1) }).passthrough())
          .optional(),
      })
      .passthrough()
      .optional(),
    compatibility_date: z.string().optional(),
    compatibility_flags: z.array(z.string()).optional(),
  })
  .passthrough()

export function projectConfig(text: string) {
  const parsed = projectConfigSchema.safeParse(parse(text))
  if (!parsed.success) throw new Error(projectConfigError(parsed.error.issues))
  const config = parsed.data
  projectPath(config.main)
  projectPath(config.assets.directory)
  return config
}
const configFieldHints: Record<string, string> = {
  assets:
    'add an [assets] table, for example [assets] directory = "public" binding = "ASSETS" run_worker_first = true',
  main: 'set main to your Worker entry file, for example main = "worker.js"',
}
// Turn schema issues into one actionable sentence instead of a raw validation dump.
function projectConfigError(issues: z.core.$ZodIssue[]): string {
  const fields = issues.map((issue) => {
    const field = issue.path.map(String).join('.') || 'wrangler.toml'
    const hint = configFieldHints[String(issue.path[0])]
    return `${field}: ${issue.message}${hint ? ` (${hint})` : ''}`
  })
  return `wrangler.toml is not a valid DeepSpace project. ${fields.join('; ')}. With starter "raw", you can omit wrangler.toml and DeepSpace supplies the starter's.`
}
export function projectPath(path: string): string {
  const normalized = path.replace(/^\.\//, '').replace(/\/$/, '')
  if (
    !normalized ||
    normalized.split('/').some((p) => !p || p === '.' || p === '..') ||
    // eslint-disable-next-line no-control-regex -- Control characters are invalid in source paths.
    /[\\\x00-\x1f\x7f]/.test(normalized)
  )
    throw new Error(`Project paths must stay inside the source tree: ${path}`)
  return normalized
}
export function identifyProject(text: string, name: string, appId: string): string {
  const config = projectConfig(text)
  const previous = config.vars?.DEEPSPACE_APP_ID
  if (previous && previous !== '__APP_ID__' && previous !== appId)
    throw new Error('The source belongs to another app. Keep its DEEPSPACE_APP_ID when updating.')
  config.name = name
  config.vars = { ...config.vars, DEEPSPACE_APP_ID: appId, APP_NAME: name }
  return stringify(config) + '\n'
}
export function rawProjectConfig(
  name: string,
  appId: string,
  durableObjects: ProjectArtifact['doManifest'] = [],
): string {
  return (
    stringify({
      name,
      main: 'worker.js',
      no_bundle: true,
      compatibility_date: '2025-01-01',
      compatibility_flags: ['nodejs_compat'],
      assets: {
        directory: 'public',
        binding: 'ASSETS',
        run_worker_first: true,
        not_found_handling: 'single-page-application',
      },
      vars: { DEEPSPACE_APP_ID: appId, APP_NAME: name },
      durable_objects: {
        bindings: durableObjects.map((d) => ({ name: d.binding, class_name: d.className })),
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: durableObjects.map((d) => d.className) }],
    }) + '\n'
  )
}
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}
export async function prepareRawProject(
  files: Record<string, string | Uint8Array>,
): Promise<ProjectArtifact> {
  const text = (path: string) => {
    const content = files[path]
    if (typeof content !== 'string') throw new Error(`Expected UTF-8 source text: ${path}`)
    return content
  }
  const config = projectConfig(text('wrangler.toml'))
  if (config.no_bundle !== true)
    throw new Error('This project needs a build; use hosted publishing or the CLI build.')
  const main = projectPath(config.main),
    directory = projectPath(config.assets.directory) + '/'
  if (!files[main]) throw new Error(`Missing Worker entrypoint: ${main}`)
  const modules = Object.entries(files)
    .filter(([p]) => !p.startsWith(directory) && /\.(js|mjs)$/i.test(p))
    .map(([name]) => ({ name, content: text(name) }))
    .sort((a, b) => (a.name === main ? -1 : b.name === main ? 1 : a.name.localeCompare(b.name)))
  const assets = await Promise.all(
    Object.entries(files)
      .filter(
        ([p]) =>
          p.startsWith(directory) &&
          !['_headers', '_redirects'].includes(p.slice(directory.length)),
      )
      .map(async ([p, content]) => {
        const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
        const hash = [
          ...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
        ]
          .map((n) => n.toString(16).padStart(2, '0'))
          .join('')
        return {
          path: '/' + p.slice(directory.length),
          size: bytes.length,
          hash,
          base64: bytesToBase64(bytes),
        }
      }),
  )
  const classes = new Set(config.migrations?.flatMap((m) => m.new_sqlite_classes ?? []) ?? [])
  const customBindings = bindingManifestFromOutputConfig(config)
  const validation = validateBindingManifest(customBindings)
  if (!validation.valid) throw new Error(validation.errors.map((e) => e.reason).join('; '))
  return {
    worker: { main, modules },
    assets,
    assetConfig: Object.fromEntries(
      ['_headers', '_redirects']
        .filter((p) => files[directory + p] !== undefined)
        .map((p) => [p, text(directory + p)]),
    ),
    doManifest: (config.durable_objects?.bindings ?? []).map((d) => ({
      binding: d.name,
      className: d.class_name,
      sqlite: classes.has(d.class_name),
    })),
    customBindings,
    appMigrations: [],
    extraRoutes:
      config.assets.run_worker_first === true
        ? true
        : Array.isArray(config.assets.run_worker_first)
          ? config.assets.run_worker_first
          : [],
    compatibilityDate: config.compatibility_date ?? null,
    compatibilityFlags: config.compatibility_flags ?? [],
    notFoundHandling: config.assets.not_found_handling ?? null,
  }
}

/** The CLI and hosted publisher emit the same deploy request fields. */
export function projectArtifactForm(
  bundle: Omit<ProjectArtifact, 'assets' | 'doManifest'> & {
    assets: Array<{ path: string; hash: string; size: number }>
    doManifest?: ProjectArtifact['doManifest']
  },
): FormData {
  const form = new FormData()
  const main = bundle.worker.modules.find((m) => m.name === bundle.worker.main)
  if (!main) throw new Error('Built Worker bundle has no main module.')
  form.append(
    'worker',
    new Blob([main.content], { type: 'application/javascript+module' }),
    main.name,
  )
  form.append('workerMain', main.name)
  const modules = bundle.worker.modules.filter((m) => m !== main)
  if (modules.length) {
    form.append('workerModules', JSON.stringify(modules.map((m) => m.name)))
    for (const module of modules)
      form.append(
        'workerModule',
        new Blob([module.content], { type: 'application/javascript+module' }),
        module.name,
      )
  }
  form.append(
    'assetManifest',
    JSON.stringify(bundle.assets.map(({ path, hash, size }) => ({ path, hash, size }))),
  )
  form.append('appMigrations', JSON.stringify(bundle.appMigrations))
  if (bundle.doManifest) form.append('doManifest', JSON.stringify(bundle.doManifest))
  if (bundle.customBindings.length)
    form.append('bindingManifest', JSON.stringify(bundle.customBindings))
  if (bundle.extraRoutes === true || bundle.extraRoutes.length)
    form.append('extraRunWorkerFirst', JSON.stringify(bundle.extraRoutes))
  if (Object.keys(bundle.assetConfig).length)
    form.append('assetConfig', JSON.stringify(bundle.assetConfig))
  if (bundle.compatibilityDate) form.append('compatibilityDate', bundle.compatibilityDate)
  if (bundle.compatibilityFlags.length)
    form.append('compatibilityFlags', JSON.stringify(bundle.compatibilityFlags))
  if (bundle.notFoundHandling) form.append('notFoundHandling', bundle.notFoundHandling)
  return form
}
