import * as p from '@clack/prompts'
import { existsSync, readFileSync } from 'node:fs'
import {
  RESERVED_BINDING_NAMES,
  type CustomBindingManifest,
} from '../../../server/rooms/binding-manifest'
import { extractCustomDevVars, parseDevVars, writeDevVars } from '../../lib/dev-vars'
import {
  refreshSecretsCache,
  stripGeneratedSecretsCache,
  type PulledSecretsCache,
} from '../../lib/secrets'
import { devVarsPathFor } from '../../lib/wrangler-env'
import type { DurableObjectManifestEntry } from './build'
import type { DeployOutput } from './output'

export interface DeploySecretsCache {
  linked: PulledSecretsCache | null
  localOnlyDevVars: Record<string, string>
}

export interface DeploySecretsPayload {
  values: Record<string, string>
  names: string[]
}

export function classifyDevVarsSecrets(options: {
  storeSecretNames: string[]
  handEditedDevVarKeys: string[]
  allowMissing: boolean
}):
  | { kind: 'ok' }
  | { kind: 'warn'; strayKeys: string[] }
  | { kind: 'block'; strayKeys: string[] } {
  const store = new Set(options.storeSecretNames)
  const strayKeys = options.handEditedDevVarKeys.filter((key) => !store.has(key))
  if (strayKeys.length === 0) return { kind: 'ok' }
  if (options.storeSecretNames.length === 0 && !options.allowMissing) {
    return { kind: 'block', strayKeys }
  }
  return { kind: 'warn', strayKeys }
}

export async function loadDeploySecrets(options: {
  deployUrl: string
  appDir: string
  appId: string
  envName: string | undefined
  ownerId: string
  token: string
  output: DeployOutput
}): Promise<DeploySecretsCache> {
  const { deployUrl, appDir, appId, envName, ownerId, token, output } = options
  let linked: PulledSecretsCache | null = null
  let localOnlyDevVars: Record<string, string> = {}

  try {
    const refreshed = await refreshSecretsCache(deployUrl, token, appId, envName)
    if (refreshed) {
      linked = refreshed.pulled
      localOnlyDevVars = readCustomDevVars(
        devVarsPathFor(appDir, envName, { sharedDevVarsCache: true }),
        output,
      )
      await writeDevVars(appDir, ownerId, token, envName, {
        appId,
        generatedSecretsCache: refreshed.rendered,
        sharedDevVarsCache: true,
      })
      if (refreshed.summary) p.log.info(refreshed.summary)
    }
  } catch (error: unknown) {
    if ((error as { status?: number })?.status === 403) {
      output.die(
        "You're not authorized to deploy this app — you must be its owner or a current " +
          'collaborator. If you were a collaborator, your access may have been revoked.',
        'not_authorized',
      )
    }
    output.die(
      `Failed to refresh app secrets before deploy: ${errorMessage(error)}`,
      'secrets_refresh_failed',
    )
  }

  return { linked, localOnlyDevVars }
}

export function prepareDeploySecrets(options: {
  appDir: string
  envName: string | undefined
  cache: DeploySecretsCache
  allowMissing: boolean
  customBindings: CustomBindingManifest
  doManifest: DurableObjectManifestEntry[] | undefined
  output: DeployOutput
}): DeploySecretsPayload {
  const { appDir, envName, cache, allowMissing, customBindings, doManifest, output } = options
  const values = cache.linked ? { ...cache.linked.values } : {}
  const devVarsPath = devVarsPathFor(appDir, envName, {
    sharedDevVarsCache: cache.linked !== null,
  })
  const handEditedDevVars = cache.linked
    ? cache.localOnlyDevVars
    : readCustomDevVars(devVarsPath, output)
  const decision = classifyDevVarsSecrets({
    storeSecretNames: Object.keys(values),
    handEditedDevVarKeys: Object.keys(handEditedDevVars),
    allowMissing,
  })

  if (decision.kind === 'block') {
    const uploadArgv = [
      'deepspace',
      'secrets',
      'upload',
      '.dev.vars',
      ...(envName ? ['-e', envName] : []),
    ]
    output.die(
      `Refusing to deploy: the app store has no secrets, but .dev.vars has ${decision.strayKeys.join(', ')}. ` +
        'Deploying now would ship the app with no secrets — replacing any secrets a previous ' +
        'deploy set (they would be dropped from production). Upload them first, then ' +
        'redeploy. (Pass --allow-missing-secrets to deploy without them.)',
      'secrets_not_uploaded',
      { action: { cwd: appDir, argv: uploadArgv } },
    )
  }
  if (decision.kind === 'warn') {
    const stray = decision.strayKeys
    p.log.warn(
      `.dev.vars has ${stray.join(', ')} not in the app store — ${stray.length === 1 ? 'it is' : 'they are'} NOT deployed. ` +
        '`.dev.vars` is a local dev cache, not deploy config. Move ' +
        `${stray.length === 1 ? 'it' : 'them'} into the store with ` +
        '`deepspace secrets set KEY=value` (or `deepspace secrets upload .dev.vars`), then redeploy.',
    )
  }

  const names = Object.keys(values)
  const declaredBindingNames = new Set([
    ...customBindings.map((binding) => binding.name),
    ...(doManifest ?? []).map((binding) => binding.binding),
  ])
  for (const name of names) {
    if (RESERVED_BINDING_NAMES.has(name)) {
      output.die(
        `App secret "${name}" is a reserved binding name — rename or remove that secret before deploying.`,
        'reserved_binding',
      )
    }
    if (declaredBindingNames.has(name)) {
      output.die(
        `App secret "${name}" collides with a binding declared in wrangler.toml — rename one or the other.`,
        'binding_collision',
      )
    }
  }
  if (names.length) p.log.info(`App secrets: ${names.join(', ')}`)

  return { values, names }
}

function readCustomDevVars(path: string, output: DeployOutput): Record<string, string> {
  if (!existsSync(path)) return {}
  const section = extractCustomDevVars(stripGeneratedSecretsCache(readFileSync(path, 'utf-8')))
  if (!section) return {}
  try {
    return parseDevVars(section)
  } catch (error: unknown) {
    output.die(`.dev.vars: ${errorMessage(error)}`, 'invalid_dev_vars')
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
