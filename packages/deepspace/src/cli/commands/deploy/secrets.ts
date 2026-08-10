/**
 * Deploy-time secrets come from the app's secret store, and only from there.
 *
 * `.dev.vars` is a generated local cache: deploy WRITES it so `deepspace dev`
 * has the same values, and never reads it back to decide anything. It used to,
 * as a guard — comparing hand-edited keys against the store to catch "you set
 * a secret locally and never uploaded it". That guard inferred intent from a
 * local file, and it broke its own escape hatch: the refusal pointed at
 * `secrets upload .dev.vars` while the same deploy had already written the
 * SDK-managed block into that file, whose keys the upload then rejected. There
 * was no way forward. One source of truth removes the guard and the dead end
 * together.
 */

import * as p from '@clack/prompts'
import {
  RESERVED_BINDING_NAMES,
  type CustomBindingManifest,
} from '../../../server/rooms/binding-manifest'
import { writeDevVars } from '../../lib/dev-vars'
import {
  defaultConfigNameForEnv,
  refreshSecretsCache,
  type PulledSecretsCache,
} from '../../lib/secrets'
import type { DurableObjectManifestEntry } from './build'
import type { DeployOutput } from './output'

export interface DeploySecretsCache {
  linked: PulledSecretsCache | null
}

export interface DeploySecretsPayload {
  values: Record<string, string>
  names: string[]
  authoritative: boolean
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

  try {
    const refreshed = await refreshSecretsCache(deployUrl, token, appId, envName)
    linked = refreshed.pulled
    await writeDevVars(appDir, ownerId, token, envName, {
      appId,
      generatedSecretsCache: refreshed.rendered,
    })
    if (refreshed.summary) p.log.info(refreshed.summary)
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

  if (!linked) {
    const configName = defaultConfigNameForEnv(envName)
    output.die(
      `Secrets config "${configName}" does not exist. Create it explicitly before deploying; ` +
        'this distinguishes an intentional empty config from an uninitialized app and protects ' +
        'live Worker secrets during the platform rollout.',
      'secrets_config_missing',
      {
        action: {
          cwd: appDir,
          argv: [
            'deepspace',
            'secrets',
            'configs',
            'create',
            configName,
            ...(envName ? ['--env', envName] : []),
          ],
        },
      },
    )
  }

  return { linked }
}

export function prepareDeploySecrets(options: {
  cache: DeploySecretsCache
  customBindings: CustomBindingManifest
  doManifest: DurableObjectManifestEntry[] | undefined
  output: DeployOutput
}): DeploySecretsPayload {
  const { cache, customBindings, doManifest, output } = options
  const values = cache.linked ? { ...cache.linked.values } : {}

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

  return { values, names, authoritative: cache.linked !== null }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
