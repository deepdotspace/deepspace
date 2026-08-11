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
import { hasWranglerConfig } from '../lib/wrangler-env'
import { assertSyncableRepo } from '../lib/git/repository'
import { cliAction, defineDeepspaceCommand, Refusal } from '../lib/command'
import {
  applyAppMigrationPlan,
  planAppMigrations,
  type AppMigrationPlan,
} from './update/app-migrations'

const REGISTRY = 'https://registry.npmjs.org/deepspace/latest'
const DOCS_URL = 'https://documentation.deep.space/cli-reference/commands'

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

/** Point the app's manifest at `version`; the install itself is the caller's. */
function pinSdkVersion(appDir: string, version: string): boolean {
  const path = join(appDir, 'package.json')
  const source = readFileSync(path, 'utf8')
  const updated = source.replace(
    /("deepspace"\s*:\s*")[^"]+(")/,
    (_match, head: string, tail: string) => `${head}^${version}${tail}`,
  )
  if (updated === source) return false
  writeFileSync(path, updated)
  return true
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
    const pinned = dryRun ? false : pinSdkVersion(appDir, targetRaw)
    if (!dryRun && plan.edits.length) applyAppMigrationPlan(appDir, plan)

    if (!args.json) {
      p.log.info(`deepspace ${currentRaw} → ${targetRaw}`)
      if (pinned) p.log.success('package.json now asks for the current SDK')
      if (!plan.pending.length && !plan.blockers.length) {
        p.log.success('No source changes required.')
      }
      reportPlan(plan, !dryRun)
    }

    // Manual work outstanding is exit 2 — "it worked, your turn" — so an agent
    // branches on the code rather than parsing prose.
    if (plan.blockers.length) {
      throw new Refusal(
        `${plan.blockers.length} change(s) need a human or agent edit; each is listed above with ` +
          `its file, line, and the change required.`,
        'manual_changes_required',
        {
          actionRequired: true,
          extra: {
            currentVersion: currentRaw,
            targetVersion: targetRaw,
            applied: plan.pending.map((migration) => migration.id),
            blockers: plan.blockers,
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
