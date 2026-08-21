/**
 * `deepspace app update` is a read-only upgrade guide for one app.
 *
 * The running CLI is the sole target-version authority. It inspects the app's
 * explicit package and migration manifests, then returns the edits and checks a
 * developer or agent must perform. It never rewrites source, stamps migrations,
 * edits package.json, runs an installer, or treats an entire Git repository as
 * the app.
 */

import * as p from '@clack/prompts'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sdkPackage from '../../../package.json'
import { defineDeepspaceCommand, Refusal } from '../lib/command'
import { detectPackageManager } from '../lib/package-manager'
import { hasWranglerConfig, noWranglerConfigMessage } from '../lib/wrangler-env'
import {
  APP_MIGRATIONS_MANIFEST,
  pendingAppMigrationGuidance,
  type AppMigrationGuidance,
} from './update/app-migrations'

const DOCS_URL = 'https://docs.deep.space/cli-reference/commands#app-update'
const RELEASE_MIGRATIONS_URL = `https://github.com/deepdotspace/deepspace/blob/v${sdkPackage.version}/docs/migrations/README.md`
const USERS_SCHEMA_VISIBILITY_GUIDE = `https://github.com/deepdotspace/deepspace/blob/v${sdkPackage.version}/docs/migrations/users-schema-member-visibility.md`
const COMPATIBLE_AI_VERSION = sdkPackage.dependencies.ai
const OLDEST_SUPPORTED_MINOR = 12

interface Version {
  major: number
  minor: number
  patch: number
}

export interface DependencyGuidance {
  dependency: string
  from: string
  to: string
}

export function parseVersion(raw: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim().replace(/^[\^~]/, ''))
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function compareVersions(left: Version, right: Version): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}

export function gapIsTooWide(from: Version, to: Version): boolean {
  if (compareVersions(from, to) >= 0) return false
  if (from.major !== to.major) return true
  return from.major === 0 && from.minor < OLDEST_SUPPORTED_MINOR
}

interface AppManifest {
  dependencies?: Record<string, unknown>
}

function readManifest(appDir: string): AppManifest {
  const path = join(appDir, 'package.json')
  if (!existsSync(path)) {
    throw new Refusal('This app has no package.json — nothing to update.', 'not_in_app_repo')
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AppManifest
  } catch {
    throw new Refusal('package.json must contain valid JSON.', 'invalid_package_manifest')
  }
}

/** The app's declared dependency spec; installed state is deliberately ignored. */
export function readAppSdkSpec(appDir: string): string | null {
  const candidate = readManifest(appDir).dependencies?.deepspace
  return typeof candidate === 'string' ? candidate : null
}

function isRegistryVersionSpec(spec: string): boolean {
  return !/^(file|link|workspace|git\+|github|https?):/.test(spec) && !spec.includes('/')
}

/** A local or VCS SDK is developer-owned, so this CLI can describe but not verify it. */
function unverifiedSdkInstruction(spec: string): string | null {
  if (isRegistryVersionSpec(spec)) return null
  return (
    `package.json declares deepspace as "${spec}", so this CLI cannot verify which SDK version ` +
    'or compatible ai version that source provides. Verify the dependency against its local or VCS build before treating this app as aligned.'
  )
}

/** Dependency edits to make manually before installing. This function never writes. */
export function planDependencyGuidance(appDir: string): DependencyGuidance[] {
  const manifest = readManifest(appDir)
  const dependencies = manifest.dependencies
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return []
  const edits: DependencyGuidance[] = []
  const deepspace = dependencies.deepspace
  // A file/link/workspace/git SDK is owned by that local build, including its
  // compatible AI version. This published CLI must not prescribe either half.
  if (typeof deepspace !== 'string' || !isRegistryVersionSpec(deepspace)) return []
  if (deepspace !== sdkPackage.version) {
    edits.push({ dependency: 'deepspace', from: deepspace, to: sdkPackage.version })
  }
  const ai = dependencies.ai
  if (typeof ai === 'string' && ai !== COMPATIBLE_AI_VERSION) {
    edits.push({ dependency: 'ai', from: ai, to: COMPATIBLE_AI_VERSION })
  }
  return edits
}

/** Existing app-owned users schemas keep their visibility until reviewed explicitly. */
export function usersSchemaVisibilityUpgradeInstruction(appDir: string): string | null {
  const schemaName = 'src/schemas/users-schema.ts'
  const path = join(appDir, schemaName)
  if (!existsSync(path)) return null
  const source = readFileSync(path, 'utf8')
  if (!/\bmember\s*:\s*\{[^}]*\bread\s*:\s*true\b/s.test(source)) return null
  return `${schemaName}: review member user-row visibility at ${USERS_SCHEMA_VISIBILITY_GUIDE}; leave the app-owned schema unchanged until you choose its policy.`
}

function migrationStep(migration: AppMigrationGuidance): string {
  return (
    `${migration.id} — ${migration.description}. Review ${migration.files.join(', ')}. ` +
    `${migration.guidance} After validating the app, add "${migration.id}" to ${APP_MIGRATIONS_MANIFEST}.`
  )
}

export default defineDeepspaceCommand({
  meta: {
    name: 'update',
    description: 'Inspect this app and print guidance for updating it to this CLI version',
  },
  async run({ args }) {
    const appDir = resolve('.')
    if (!hasWranglerConfig(appDir)) {
      throw new Refusal(noWranglerConfigMessage(join(appDir, 'wrangler.toml')), 'not_in_app_repo')
    }

    const currentSpec = readAppSdkSpec(appDir)
    if (!currentSpec) {
      throw new Refusal(
        'This app does not declare `deepspace` in package.json dependencies — nothing to update.',
        'not_in_app_repo',
      )
    }
    const targetVersion = sdkPackage.version
    const current = parseVersion(currentSpec)
    const target = parseVersion(targetVersion)!
    const packageManager = detectPackageManager(appDir)

    const versionGuidance =
      current && compareVersions(current, target) > 0
        ? {
            status: 'cli_version_behind',
            step: `Run the matching or latest CLI (npx deepspace@latest app update); this CLI ${targetVersion} is older than the app dependency ${currentSpec}.`,
          }
        : current && gapIsTooWide(current, target)
          ? {
              status: 'version_gap_too_wide',
              step: `Review the releases between deepspace ${currentSpec} and ${targetVersion} one at a time; the version gap is too wide for one current-release checklist. Follow ${DOCS_URL}.`,
            }
          : null
    if (versionGuidance) {
      const steps = [versionGuidance.step]
      if (!args.json) p.log.warn(versionGuidance.step)
      return {
        data: {
          ready: false,
          status: versionGuidance.status,
          currentSpec,
          targetVersion,
          packageManager,
          dependencies: [],
          migrations: [],
          manualInstructions: [],
          steps,
          guidanceUrl: DOCS_URL,
          writes: [],
        },
      }
    }

    const dependencies = planDependencyGuidance(appDir)
    const migrations = pendingAppMigrationGuidance(appDir)
    const usersSchema = usersSchemaVisibilityUpgradeInstruction(appDir)
    const unverifiedSdk = unverifiedSdkInstruction(currentSpec)
    const manualInstructions = [
      ...(unverifiedSdk ? [unverifiedSdk] : []),
      ...(usersSchema ? [usersSchema] : []),
    ]
    const steps = [
      ...dependencies.map(
        ({ dependency, from, to }) =>
          `In package.json, change ${dependency} from "${from}" to "${to}".`,
      ),
      ...(dependencies.length ? [`Run ${packageManager} install.`] : []),
      ...migrations.map(migrationStep),
      ...manualInstructions,
      ...(dependencies.length || migrations.length || usersSchema
        ? ["Run the app's type-check and tests, review the diff, then commit it."]
        : []),
    ]

    const status = unverifiedSdk
      ? 'dependency_unverified'
      : steps.length === 0
        ? 'aligned'
        : 'guidance_available'

    if (!args.json) {
      p.log.info(`App dependency: ${currentSpec}; guidance owner: deepspace CLI ${targetVersion}`)
      for (const step of steps) p.log.message(`• ${step}`)
      if (steps.length === 0) p.log.success('This app is already aligned with this CLI version.')
    }

    const data = {
      ready: status === 'aligned',
      status,
      currentSpec,
      targetVersion,
      packageManager,
      dependencies,
      migrations,
      manualInstructions,
      steps,
      guidanceUrl: RELEASE_MIGRATIONS_URL,
      writes: [],
    }
    return { data }
  },
})
