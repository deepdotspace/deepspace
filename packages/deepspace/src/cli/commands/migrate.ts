/** `deepspace app migrate` — ordered, idempotent app upgrade workflow. */

import { ensureToken } from '../auth'
import { findAppDir } from '../lib/app-context'
import { mintAppId, readAppId, writeAppId } from '../lib/app-identity'
import {
  APP_MIGRATION_DEFINITIONS,
  applyAppMigrationPlan,
  planAppMigrations,
  type AppMigrationPlan,
} from './migrate/app-migrations'
import { defineDeepspaceCommand, Refusal } from '../lib/command'
import {
  assertSyncableRepo,
  currentBranch,
  isWorkTreeClean,
  repoToplevel,
  resolveCommit,
} from '../lib/git/repository'
import { statusFiles } from '../lib/git/safety'
import { gitLine, runGit } from '../lib/git/process'
import {
  cancelIdentityMigration,
  commitIdentityMigration,
  getIdentityMigration,
  inspectIdentityMigration,
  prepareIdentityMigration,
  verifyIdentityMigration,
  type IdentityMigration,
} from './migrate/identity-api'
import { readLegacyAppId } from './migrate/legacy-app-id'
import { repoApi } from '../lib/repo-api'
import { selectGitHubRemote, remoteBranchOid, type GitHubRemote } from '../lib/source-control'
import { getAppSource } from '../lib/source-api'
import { deployBaseUrl } from '../lib/vc-remote'
import { validateAppMigrationIds } from '../../shared/protocol/app-migrations'

const STRICT_APP_ID_RE = /^app_[0-9A-HJKMNP-TV-Z]{26}$/

export default defineDeepspaceCommand({
  meta: {
    name: 'migrate',
    description: 'Apply pending DeepSpace app migrations without moving retained data',
  },
  args: {
    remote: {
      type: 'string',
      description: 'GitHub remote name when it cannot be inferred (default: origin)',
      required: false,
    },
    env: {
      type: 'string',
      alias: 'e',
      description: 'wrangler.toml environment whose app id should be migrated',
      required: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Inspect prerequisites and show the migration without changing anything',
      default: false,
    },
    cancel: {
      type: 'boolean',
      description: 'Cancel a prepared migration after restoring and publishing the legacy id',
      default: false,
    },
  },
  async run({ args }) {
    const recoveryMode = args.cancel === true ? 'cancel' : null
    const exclusiveModes = [args['dry-run'], args.cancel].filter(Boolean).length
    if (exclusiveModes > 1) {
      throw new Refusal('Use only one of --dry-run or --cancel.', 'conflicting_migration_mode')
    }
    const appDir = findAppDir()
    if (!appDir) {
      throw new Refusal('Run this command from a DeepSpace app Git checkout.', 'not_in_app_repo')
    }
    assertSyncableRepo(appDir)
    const envName = typeof args.env === 'string' && args.env ? args.env : undefined
    const currentAppId = readAppId(appDir, envName) ?? readLegacyAppId(appDir, envName)
    if (!currentAppId) {
      throw new Refusal(
        'wrangler.toml has no unambiguous DeepSpace app identity for this environment.',
        'missing_app_id',
      )
    }
    if (!STRICT_APP_ID_RE.test(currentAppId)) requireTrackedWrangler(appDir)

    const token = await ensureToken()
    const deployUrl = deployBaseUrl()
    const existingMigration = await getIdentityMigration(deployUrl, token, currentAppId)

    if (recoveryMode) {
      if (!existingMigration) {
        if (!args.json) console.log('No reversible identity migration is recorded.')
        return { data: { status: 'no_migration', appId: currentAppId } }
      }
      return recoverMigration({
        mode: recoveryMode,
        appDir,
        envName,
        remoteName: typeof args.remote === 'string' ? args.remote : undefined,
        currentAppId,
        token,
        deployUrl,
        migration: existingMigration,
        json: args.json,
      })
    }

    const sourcePlan = planAppMigrations(appDir)
    if (sourcePlan.blockers.length > 0) {
      const first = sourcePlan.blockers[0]!
      throw new Refusal(
        `Migration ${first.migrationId} needs a manual source update at ${first.file}:${first.line}. ${first.message}`,
        'source_migration_blocked',
        { extra: { blockers: sourcePlan.blockers } },
      )
    }

    if (STRICT_APP_ID_RE.test(currentAppId)) {
      if (!existingMigration) {
        if (args['dry-run'] && sourcePlan.pending.length > 0) {
          reportSourcePlan(sourcePlan, args.json)
          return {
            data: {
              status: 'ready',
              appId: currentAppId,
              sourceMigrations: sourcePlan.pending,
            },
          }
        }
        if (sourcePlan.pending.length > 0) {
          requireSourceMigrationWorktree(appDir)
          applyAppMigrationPlan(appDir, sourcePlan)
          throw sourceMigrationCommitRequired(appDir, sourcePlan)
        }
        await requireSourceMigrationDeploy(appDir, currentAppId, deployUrl, token, {
          envName,
          remoteName: typeof args.remote === 'string' ? args.remote : undefined,
        })
        reportUpToDate(currentAppId, args.json)
        return { data: { status: 'up_to_date', appId: currentAppId } }
      }
      if (sourcePlan.pending.length === 0 && existingMigration.status === 'verified') {
        await requireSourceMigrationDeploy(appDir, currentAppId, deployUrl, token, {
          envName,
          remoteName: typeof args.remote === 'string' ? args.remote : undefined,
        })
      }
      if (args['dry-run']) {
        reportMigration(existingMigration, args.json)
        reportSourcePlan(sourcePlan, args.json)
        return {
          data: {
            status: existingMigration.status,
            migration: existingMigration,
            sourceMigrations: sourcePlan.pending,
          },
        }
      }
      if (sourcePlan.pending.length > 0) {
        requireSourceMigrationWorktree(appDir, existingMigration.status === 'prepared')
        applyAppMigrationPlan(appDir, sourcePlan)
        throw existingMigration.status === 'prepared'
          ? commitRequired(appDir, existingMigration, envName, sourcePlan.changedFiles)
          : sourceMigrationCommitRequired(appDir, sourcePlan)
      }
      return continuePreparedMigration({
        appDir,
        envName,
        remoteName: typeof args.remote === 'string' ? args.remote : undefined,
        token,
        deployUrl,
        migration: existingMigration,
        json: args.json,
      })
    }

    // A legacy-valued checkout may safely resume a prepared journal, but it
    // must never deploy that old identity after the registry has cut over.
    // The committed GitHub evidence already names the canonical-id commit;
    // require the operator to restore/checkout that exact configuration.
    if (
      existingMigration &&
      existingMigration.status !== 'prepared' &&
      existingMigration.status !== 'rolled_back'
    ) {
      throw new Refusal(
        `The registry already uses ${existingMigration.appId}, but wrangler.toml still uses ${currentAppId}. Restore the migration commit before deploying.`,
        'migration_config_stale',
        { extra: { migration: existingMigration } },
      )
    }

    const remote = requireGitHubRemote(
      appDir,
      typeof args.remote === 'string' ? args.remote : undefined,
    )
    const head = requirePublishedHead(appDir, remote)
    const proposedAppId = existingMigration?.appId ?? mintAppId()
    const inventory = await inspectIdentityMigration(deployUrl, token, currentAppId, {
      destinationAppId: proposedAppId,
      repository: remote.repository,
    })
    if (!inventory.ready) {
      throw new Refusal(
        `Migration preflight is blocked: ${inventory.blockers.map((blocker) => blocker.message).join('; ')}`,
        'migration_preflight_blocked',
        { extra: { inventory } },
      )
    }

    if (args['dry-run']) {
      if (!args.json) {
        console.log(`Legacy app: ${currentAppId}`)
        console.log(`GitHub: ${remote.repository} (${head.branch} @ ${head.oid.slice(0, 10)})`)
        console.log(
          `Immutable app id: ${proposedAppId}${existingMigration ? '' : ' (not reserved)'}`,
        )
        console.log(
          `Registry rows to re-key: app=1 routes=${inventory.rekey.routes.length} collaborators=${inventory.rekey.collaborators.length} pendingInvites=${inventory.rekey.pendingCollaborators.length} transfers=${inventory.rekey.transfer ? 1 : 0}`,
        )
        console.log(
          `Physical stores retained at ${inventory.app.resourceId}: ${inventory.retainedPhysicalStores.map((store) => store.kind).join(', ')}`,
        )
        console.log('No changes made.')
      }
      reportSourcePlan(sourcePlan, args.json)
      return {
        data: {
          status: 'ready',
          legacyAppId: currentAppId,
          proposedAppId,
          resourceId: inventory.app.resourceId,
          repository: remote.repository,
          branch: head.branch,
          commitOid: head.oid,
          sourceClaimRequired: inventory.app.sourceClaimRequired,
          sourceMigrations: sourcePlan.pending,
          inventory,
        },
      }
    }

    const migration =
      existingMigration?.status === 'prepared'
        ? existingMigration
        : await prepareIdentityMigration(deployUrl, token, currentAppId, {
            destinationAppId: proposedAppId,
            repository: remote.repository,
            expectedSourceRevision: inventory.app.sourceRevision,
          })

    applyAppMigrationPlan(appDir, sourcePlan)
    writeAppId(appDir, migration.appId, { wranglerEnv: envName, force: true })
    throw commitRequired(appDir, migration, envName, sourcePlan.changedFiles)
  },
})

async function recoverMigration(input: {
  mode: 'cancel'
  appDir: string
  envName?: string
  remoteName?: string
  currentAppId: string
  token: string
  deployUrl: string
  migration: IdentityMigration
  json: boolean
}) {
  const { appDir, envName, remoteName, currentAppId, token, deployUrl, migration, json } = input

  if (migration.status === 'rolled_back') {
    if (currentAppId !== migration.legacyAppId) {
      writeAppId(appDir, migration.legacyAppId, { wranglerEnv: envName, force: true })
      throw restoreLegacyCommitRequired(appDir, migration, envName)
    }
    reportMigration(migration, json)
    return { data: { status: 'rolled_back', migration } }
  }
  if (migration.status !== 'prepared') {
    throw new Refusal(
      'This migration is already committed. Complete it by deploying the canonical app.',
      'forward_recovery_required',
      { extra: { migration } },
    )
  }

  // GitHub is authoritative for every legacy app. Publish the legacy-valued
  // configuration before removing/reversing the server journal so no checkout
  // can be stranded at a canonical id the registry no longer recognizes.
  if (currentAppId !== migration.legacyAppId) {
    writeAppId(appDir, migration.legacyAppId, { wranglerEnv: envName, force: true })
    throw restoreLegacyCommitRequired(appDir, migration, envName)
  }
  const remote = requireGitHubRemote(appDir, remoteName, migration.repository)
  requirePublishedHead(appDir, remote)

  await cancelIdentityMigration(deployUrl, token, migration.legacyAppId)
  if (!json) console.log(`Canceled ${migration.legacyAppId} → ${migration.appId}.`)
  return { data: { status: 'cancelled', legacyAppId: migration.legacyAppId } }
}

async function continuePreparedMigration(input: {
  appDir: string
  envName?: string
  remoteName?: string
  token: string
  deployUrl: string
  migration: IdentityMigration
  json: boolean
}) {
  const { appDir, envName, remoteName, token, deployUrl, migration, json } = input
  if (migration.status === 'rolled_back') {
    throw new Refusal(
      `This migration was rolled back. Restore DEEPSPACE_APP_ID to ${migration.legacyAppId} before continuing.`,
      'migration_rolled_back',
    )
  }
  if (migration.status === 'verified') {
    reportMigration(migration, json)
    return { data: { status: 'verified', migration } }
  }
  if (migration.status === 'committed') {
    await requireSourceMigrationDeploy(appDir, migration.appId, deployUrl, token, {
      envName,
      remoteName,
      after: migration.committedAt ?? undefined,
    })
    const verified = await verifyIdentityMigration(deployUrl, token, migration.appId)
    reportMigration(verified, json)
    return { data: { status: 'verified', migration: verified } }
  }

  if (!isWorkTreeClean(appDir)) {
    const wranglerPath = wranglerRepoPath(appDir)
    if (statusFiles(repoToplevel(appDir)).includes(wranglerPath)) {
      throw commitRequired(appDir, migration, envName)
    }
    throw new Refusal(
      'Commit or discard unrelated working-tree changes before completing the migration.',
      'dirty_worktree',
    )
  }

  const remote = requireGitHubRemote(appDir, remoteName, migration.repository)
  const head = requireLocalHead(appDir)
  const remoteOid = remoteBranchOid(appDir, remote.name, head.branch)
  if (remoteOid !== head.oid) {
    throw new Refusal(
      `GitHub ${remote.repository} does not have ${head.branch} at ${head.oid.slice(0, 10)}. Push the migration commit, then rerun.`,
      'github_push_required',
      {
        actionRequired: true,
        action: { cwd: appDir, argv: ['git', 'push', remote.name, head.branch] },
        extra: { appId: migration.appId, repository: remote.repository, ...head },
      },
    )
  }

  const committed = await commitIdentityMigration(deployUrl, token, migration.appId, {
    commitOid: head.oid,
    branch: head.branch,
  })
  throw deployRequired(appDir, committed, envName)
}

function requireGitHubRemote(
  appDir: string,
  remoteName?: string,
  repository?: string,
): GitHubRemote {
  const selected = selectGitHubRemote(appDir, { name: remoteName, repository })
  if (selected) return selected
  throw new Refusal(
    remoteName
      ? `Remote "${remoteName}" is not the expected GitHub repository.`
      : repository
        ? `No local GitHub remote points at ${repository}. Add one or pass --remote <name>.`
        : 'No unambiguous GitHub remote was found. Add `origin` or pass --remote <name>.',
    'github_remote_required',
  )
}

function requireLocalHead(appDir: string): { branch: string; oid: string } {
  const branch = currentBranch(appDir)
  if (!branch) throw new Refusal('HEAD is detached; switch to a branch first.', 'detached_head')
  const oid = resolveCommit(appDir, 'HEAD')
  if (!oid) throw new Refusal('The repository has no commit to publish.', 'no_commits')
  return { branch, oid }
}

function requirePublishedHead(
  appDir: string,
  remote: GitHubRemote,
): { branch: string; oid: string } {
  if (!isWorkTreeClean(appDir)) {
    throw new Refusal(
      'Commit or discard local changes before preparing migration.',
      'dirty_worktree',
    )
  }
  const head = requireLocalHead(appDir)
  if (remoteBranchOid(appDir, remote.name, head.branch) !== head.oid) {
    throw new Refusal(
      `GitHub ${remote.repository} does not have ${head.branch} at ${head.oid.slice(0, 10)}. Push it, then rerun.`,
      'github_push_required',
      {
        actionRequired: true,
        action: { cwd: appDir, argv: ['git', 'push', remote.name, head.branch] },
        extra: { repository: remote.repository, ...head },
      },
    )
  }
  return head
}

function commitRequired(
  appDir: string,
  migration: IdentityMigration,
  envName?: string,
  additionalPaths: string[] = [],
): Refusal {
  const wranglerPath = wranglerRepoPath(appDir)
  const migrationPaths = [...new Set([wranglerPath, ...additionalPaths])].sort()
  return new Refusal(
    `Prepared ${migration.legacyAppId} → ${migration.appId}. Commit the deterministic app migration changes, then rerun.`,
    'migration_commit_required',
    {
      actionRequired: true,
      action: {
        cwd: repoToplevel(appDir),
        argv: [
          'git',
          'commit',
          '--only',
          '--message',
          `Migrate DeepSpace app identity to ${migration.appId}`,
          '--',
          ...migrationPaths,
        ],
      },
      extra: { migration, env: envName ?? null },
    },
  )
}

function sourceMigrationCommitRequired(appDir: string, plan: AppMigrationPlan): Refusal {
  const migrationIds = plan.pending.map((migration) => migration.id)
  return new Refusal(
    `Applied ${migrationIds.join(', ')}. Commit the deterministic app migration changes, then rerun.`,
    'migration_commit_required',
    {
      actionRequired: true,
      action: {
        cwd: repoToplevel(appDir),
        argv: [
          'git',
          'commit',
          '--only',
          '--message',
          'Apply DeepSpace app migrations',
          '--',
          ...plan.changedFiles,
        ],
      },
      extra: { sourceMigrations: plan.pending },
    },
  )
}

async function requireSourceMigrationDeploy(
  appDir: string,
  appId: string,
  deployUrl: string,
  token: string,
  options: { envName?: string; remoteName?: string; after?: string } = {},
): Promise<void> {
  const { release } = await repoApi(deployUrl, token, appId).latestRelease()
  const deployedIds = releaseMigrationIds(release?.config)
  const pendingIds = APP_MIGRATION_DEFINITIONS.map(({ id }) => id).filter(
    (id) => !deployedIds.has(id),
  )
  const releaseAfterCutover =
    options.after === undefined ||
    (typeof release?.createdAt === 'string' &&
      Number.isFinite(Date.parse(release.createdAt)) &&
      Date.parse(release.createdAt) > Date.parse(options.after))
  if (pendingIds.length === 0 && releaseAfterCutover) return

  const sourceState = await getAppSource(deployUrl, token, appId)
  if (sourceState.source?.provider === 'github') {
    const remote = requireGitHubRemote(appDir, options.remoteName, sourceState.source.repository)
    requirePublishedHead(appDir, remote)
  }

  throw new Refusal(
    pendingIds.length > 0
      ? `App migrations ${pendingIds.join(', ')} are not in the live release. Deploy them, then rerun.`
      : 'The canonical app has not been deployed since its identity cutover. Deploy it, then rerun.',
    'migration_deploy_required',
    {
      actionRequired: true,
      action: {
        cwd: appDir,
        argv: ['deepspace', 'deploy', ...(options.envName ? ['--env', options.envName] : [])],
      },
      extra: { appId, sourceMigrations: pendingIds, after: options.after ?? null },
    },
  )
}

function releaseMigrationIds(config: unknown): Set<string> {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return new Set()
  const validation = validateAppMigrationIds(
    (config as { appMigrations?: unknown }).appMigrations ?? [],
  )
  return new Set(validation.valid ? validation.ids : [])
}

function requireSourceMigrationWorktree(appDir: string, allowDirtyWrangler = false): void {
  if (isWorkTreeClean(appDir)) return
  const changed = statusFiles(repoToplevel(appDir))
  if (allowDirtyWrangler && changed.every((path) => path === wranglerRepoPath(appDir))) return
  throw new Refusal(
    'Commit or discard unrelated working-tree changes before applying app migrations.',
    'dirty_worktree',
  )
}

function restoreLegacyCommitRequired(
  appDir: string,
  migration: IdentityMigration,
  envName?: string,
): Refusal {
  const wranglerPath = wranglerRepoPath(appDir)
  return new Refusal(
    `Restored ${migration.legacyAppId} in wrangler.toml. Commit and push this recovery change, then rerun.`,
    'migration_restore_commit_required',
    {
      actionRequired: true,
      action: {
        cwd: repoToplevel(appDir),
        argv: [
          'git',
          'commit',
          '--only',
          '--message',
          `Restore DeepSpace app identity to ${migration.legacyAppId}`,
          '--',
          wranglerPath,
        ],
      },
      extra: { migration, env: envName ?? null },
    },
  )
}

function wranglerRepoPath(appDir: string): string {
  return `${gitLine(appDir, ['rev-parse', '--show-prefix'])}wrangler.toml`
}

function requireTrackedWrangler(appDir: string): void {
  const path = wranglerRepoPath(appDir)
  if (
    runGit(repoToplevel(appDir), ['ls-files', '--error-unmatch', '--', path], { allowFail: true })
      .status !== 0
  ) {
    throw new Refusal(
      'Track, commit, and push wrangler.toml before migrating; GitHub must already contain the deployment configuration.',
      'wrangler_not_tracked',
    )
  }
}

function deployRequired(appDir: string, migration: IdentityMigration, envName?: string): Refusal {
  return new Refusal(
    `Identity cutover committed; deploy once to verify ${migration.appId} on the existing physical resources.`,
    'migration_deploy_required',
    {
      actionRequired: true,
      action: {
        cwd: appDir,
        argv: ['deepspace', 'deploy', ...(envName ? ['--env', envName] : [])],
      },
      extra: { migration, env: envName ?? null },
    },
  )
}

function reportUpToDate(appId: string, json: boolean): void {
  if (!json) console.log(`No pending DeepSpace app migrations for ${appId}.`)
}

function reportSourcePlan(plan: AppMigrationPlan, json: boolean): void {
  if (json || plan.pending.length === 0) return
  for (const migration of plan.pending) {
    console.log(
      `Pending source migration: ${migration.id} (${migration.files.length} file${migration.files.length === 1 ? '' : 's'})`,
    )
  }
}

function reportMigration(migration: IdentityMigration, json: boolean): void {
  if (json) return
  console.log(`Migration: ${migration.legacyAppId} → ${migration.appId}`)
  console.log(`Status: ${migration.status}`)
  console.log(`Physical resources: ${migration.resourceId}`)
  console.log(`GitHub: ${migration.repository}`)
}
