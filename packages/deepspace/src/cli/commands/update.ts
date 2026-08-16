/**
 * `deepspace app update` — move an app onto the current SDK, and make the source
 * changes that move implies.
 *
 * An app's worker code is a COPY, scaffolded once and owned by its author
 * (docs/platform/app-platform-contract.md). So when the platform's contract
 * changes, something has to carry those copies forward, and that something has
 * to cope with a file the author may have edited. This command does the part a
 * machine can do exactly, and states the rest precisely enough to act on:
 *
 *   - deterministic edits are applied (`planAppMigrations` transforms)
 *   - what a transform cannot safely touch is reported as a BLOCKER with its
 *     file, line, and the change required — the output an agent can execute
 *   - too wide a version gap is not guessed at: it points at the docs
 *
 * Replaces `deepspace app migrate`, which only ever knew one historical cutover.
 *
 * Defined with the command runtime (lib/command.ts): `--json`, the envelope,
 * the slug and the exit codes come from there. Exit 2 ("your turn") whenever
 * manual steps remain.
 */

import * as p from '@clack/prompts'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sdkPackage from '../../../package.json'
import { hasWranglerConfig } from '../lib/wrangler-env'
import { assertSyncableRepo } from '../lib/git/repository'
import { cliAction, defineDeepspaceCommand, Refusal } from '../lib/command'
import {
  applyAppMigrationPlan,
  planAppMigrations,
  type AppMigrationPlan,
} from './update/app-migrations'

const REGISTRY = 'https://registry.npmjs.org/deepspace/latest'
const DOCS_URL = 'https://docs.deep.space/cli-reference/commands'
const RELEASE_DOCS_URL = `https://github.com/deepdotspace/deepspace/blob/v${sdkPackage.version}/docs/migrations`
const BUILD_PREVIEW_SECRETS_GUIDE = `${RELEASE_DOCS_URL}/build-preview-secrets.md`
const USERS_SCHEMA_VISIBILITY_GUIDE = `${RELEASE_DOCS_URL}/users-schema-member-visibility.md`
const COMPATIBLE_AI_VERSION = sdkPackage.dependencies.ai

/**
 * The oldest version this command will carry forward in one step. Below it the
 * accumulated changes stop being a patch and start being a rewrite, and
 * pretending otherwise would hand someone a half-migrated app.
 */
const OLDEST_SUPPORTED_MINOR = 12

interface Version {
  major: number
  minor: number
  patch: number
}

export function parseVersion(raw: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim().replace(/^[\^~]/, ''))
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * Whether one step can carry `from` to `to`, or whether the gap is wide enough
 * that the honest answer is the documentation.
 */
export function gapIsTooWide(from: Version, to: Version): boolean {
  if (from.major !== to.major) return true
  return from.major === 0 && from.minor < OLDEST_SUPPORTED_MINOR
}

/** The `deepspace` version the app currently builds against. */
export function readAppSdkVersion(appDir: string): string | null {
  const installed = join(appDir, 'node_modules', 'deepspace', 'package.json')
  if (existsSync(installed)) {
    const parsed = JSON.parse(readFileSync(installed, 'utf8')) as { version?: unknown }
    if (typeof parsed.version === 'string') return parsed.version
  }
  const manifest = join(appDir, 'package.json')
  if (!existsSync(manifest)) return null
  const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
    dependencies?: Record<string, string>
  }
  return parsed.dependencies?.deepspace ?? null
}

/** Point the app's manifest at one compatible SDK/AI dependency set. */
export function pinSdkVersion(appDir: string, version: string): boolean {
  const path = join(appDir, 'package.json')
  const source = readFileSync(path, 'utf8')
  const manifest = JSON.parse(source) as { dependencies?: Record<string, unknown> }
  const dependencies = manifest.dependencies
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return false

  let changed = false
  if (
    Object.prototype.hasOwnProperty.call(dependencies, 'deepspace') &&
    typeof dependencies.deepspace === 'string' &&
    dependencies.deepspace !== `^${version}`
  ) {
    dependencies.deepspace = `^${version}`
    changed = true
  }
  // Apps use AI SDK types directly for tools and actions. A second `ai` minor
  // can carry incompatible branded types even though both packages compile on
  // their own, so update the existing direct dependency with the SDK.
  if (
    Object.prototype.hasOwnProperty.call(dependencies, 'ai') &&
    typeof dependencies.ai === 'string' &&
    dependencies.ai !== COMPATIBLE_AI_VERSION
  ) {
    dependencies.ai = COMPATIBLE_AI_VERSION
    changed = true
  }
  if (!changed) return false
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const indent = source.match(/\r?\n([\t ]+)"/)?.[1] ?? '  '
  const finalEol = source.endsWith('\n') ? eol : ''
  writeFileSync(path, JSON.stringify(manifest, null, indent).replaceAll('\n', eol) + finalEol)
  return true
}

/** Existing app-owned Vite configs need the fresh scaffold's post-build cleanup. */
export function buildPreviewSecretsUpgradeInstruction(appDir: string): string | null {
  const configName = [
    'vite.config.ts',
    'vite.config.mts',
    'vite.config.js',
    'vite.config.mjs',
  ].find((candidate) => existsSync(join(appDir, candidate)))
  if (!configName) return null
  const source = readFileSync(join(appDir, configName), 'utf8')
  // Either form satisfies the contract: the legacy inline plugin, or the
  // deepspace/build plugin that now owns the cleanup (0.23.0 scaffolds).
  if (
    source.includes('deepspace-remove-build-preview-secrets') ||
    source.includes('deepspaceBuild(') ||
    source.includes("'deepspace/build'") ||
    source.includes('"deepspace/build"')
  ) {
    return null
  }
  return `${configName}: adopt the deepspaceBuild() plugin from deepspace/build (which owns this cleanup), or add the inline cleanup from ${BUILD_PREVIEW_SECRETS_GUIDE}; app update left this app-owned file unchanged.`
}

/** Existing app-owned users schemas keep their current visibility until edited explicitly. */
export function usersSchemaVisibilityUpgradeInstruction(appDir: string): string | null {
  const schemaName = 'src/schemas/users-schema.ts'
  const path = join(appDir, schemaName)
  if (!existsSync(path)) return null
  const source = readFileSync(path, 'utf8')
  if (!/\bmember\s*:\s*\{[^}]*\bread\s*:\s*true\b/s.test(source)) return null
  return `${schemaName}: review the member user-row visibility change at ${USERS_SCHEMA_VISIBILITY_GUIDE}; app update left this app-owned schema unchanged.`
}

async function latestPublishedVersion(): Promise<string> {
  const response = await fetch(REGISTRY, { signal: AbortSignal.timeout(15_000) }).catch(
    (error: unknown) => {
      throw new Refusal(
        `Could not reach the npm registry to find the latest version: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Pass --to <version> to update without a lookup.`,
        'registry_unreachable',
      )
    },
  )
  if (!response.ok) {
    throw new Refusal(
      `The npm registry answered ${response.status} for the latest deepspace version. ` +
        `Pass --to <version> to update without a lookup.`,
      'registry_unreachable',
    )
  }
  const body = (await response.json()) as { version?: unknown }
  if (typeof body.version !== 'string') {
    throw new Refusal('The npm registry returned no version for deepspace.', 'registry_unreachable')
  }
  return body.version
}

/** Human rendering of a plan; the JSON envelope carries the same fields. */
function reportPlan(plan: AppMigrationPlan, applied: boolean): void {
  for (const migration of plan.pending) {
    const verb = applied ? 'Applied' : 'Would apply'
    p.log.success(
      `${verb}: ${migration.description} — ${migration.replacements} change(s) in ` +
        `${migration.files.join(', ')}`,
    )
  }
  if (plan.blockers.length) {
    p.log.warn(
      `${plan.blockers.length} change(s) could not be made for you — this file differs from ` +
        `the version the change was written against:`,
    )
    for (const blocker of plan.blockers) {
      p.log.message(`  ${blocker.file}:${blocker.line}\n    ${blocker.message}`)
    }
  }
}

export default defineDeepspaceCommand({
  meta: {
    name: 'update',
    description: 'Move this app onto the current SDK and apply the source changes it requires',
  },
  args: {
    to: {
      type: 'string',
      description: 'Target version (default: the latest published deepspace)',
      required: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Report what would change without touching the checkout',
      default: false,
    },
  },
  async run({ args }) {
    const appDir = resolve('.')
    if (!hasWranglerConfig(appDir)) {
      throw new Refusal(
        'No wrangler.toml found — run this from inside a DeepSpace app directory.',
        'not_in_app_repo',
      )
    }
    // The plan is built from tracked files, so a missing repo is a refusal
    // with a fix, not a raw `git rev-parse` failure surfacing from four
    // frames down.
    assertSyncableRepo(appDir)

    const currentRaw = readAppSdkVersion(appDir)
    if (!currentRaw) {
      throw new Refusal(
        'This app does not depend on `deepspace` — nothing to update.',
        'not_in_app_repo',
      )
    }
    const targetRaw =
      typeof args.to === 'string' && args.to.trim()
        ? args.to.trim()
        : await latestPublishedVersion()

    const current = parseVersion(currentRaw)
    const target = parseVersion(targetRaw)
    if (!current || !target) {
      throw new Refusal(
        `Could not read a version to update from ("${currentRaw}") or to ("${targetRaw}").`,
        'invalid_version',
      )
    }

    // Too far back to carry in one step: say so instead of half-doing it.
    if (gapIsTooWide(current, target)) {
      throw new Refusal(
        `This app is on deepspace ${currentRaw} and the current release is ${targetRaw}. ` +
          `That gap is too wide to migrate automatically — the changes between them are ` +
          `structural, not mechanical. Follow the upgrade guide instead: ${DOCS_URL}`,
        'version_gap_too_wide',
        { actionRequired: true, extra: { currentVersion: currentRaw, targetVersion: targetRaw } },
      )
    }

    const dryRun = args['dry-run'] === true
    const plan = planAppMigrations(appDir)
    const previewSecretsInstruction = buildPreviewSecretsUpgradeInstruction(appDir)
    const usersSchemaInstruction = usersSchemaVisibilityUpgradeInstruction(appDir)
    const manualInstructions = [previewSecretsInstruction, usersSchemaInstruction].filter(
      (instruction): instruction is string => instruction !== null,
    )
    const pinned = dryRun ? false : pinSdkVersion(appDir, targetRaw)
    if (!dryRun && plan.edits.length) applyAppMigrationPlan(appDir, plan)

    if (!args.json) {
      p.log.info(`deepspace ${currentRaw} → ${targetRaw}`)
      if (pinned) p.log.success('package.json now asks for the current SDK')
      for (const instruction of manualInstructions) p.log.warn(instruction)
      if (!plan.pending.length && !plan.blockers.length) {
        p.log.success('No automatic source changes required.')
      }
      reportPlan(plan, !dryRun)
    }

    // Manual work outstanding is exit 2 — "it worked, your turn" — so an agent
    // branches on the code rather than parsing prose.
    if (plan.blockers.length || manualInstructions.length) {
      const remaining = plan.blockers.length + manualInstructions.length
      throw new Refusal(
        `${remaining} change(s) need a human or agent edit; follow the returned manual instructions and blockers.`,
        'manual_changes_required',
        {
          ...(pinned ? { action: cliAction('npm', 'install') } : {}),
          actionRequired: true,
          extra: {
            currentVersion: currentRaw,
            targetVersion: targetRaw,
            applied: plan.pending.map((migration) => migration.id),
            blockers: plan.blockers,
            manualInstructions,
          },
        },
      )
    }

    return {
      data: {
        currentVersion: currentRaw,
        targetVersion: targetRaw,
        pinned,
        dryRun,
        manualInstructions,
        applied: plan.pending.map((migration) => ({
          id: migration.id,
          description: migration.description,
          files: migration.files,
          replacements: migration.replacements,
        })),
      },
      // The dependency is pinned but not installed: installing is the package
      // manager's job, and guessing which one an app uses is how a CLI breaks
      // a pnpm or bun project.
      ...(pinned ? { action: cliAction('npm', 'install') } : {}),
    }
  },
})
