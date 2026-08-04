import { apiFetch, ApiError } from '../../lib/api'

export type IdentityMigrationStatus = 'prepared' | 'committed' | 'verified' | 'rolled_back'

export interface IdentityMigration {
  legacyAppId: string
  appId: string
  resourceId: string
  ownerUserId: string
  repository: string
  sourceRevision: number
  status: IdentityMigrationStatus
  preparedAt: string
  committedAt: string | null
  verifiedAt: string | null
  rolledBackAt: string | null
  commitOid: string | null
  branch: string | null
  versionId: string | null
}

export interface IdentityMigrationInventory {
  observedAt: string
  ready: boolean
  blockers: Array<{
    code: 'source_changed' | 'destination_taken' | 'pending_transfer' | 'different_migration'
    message: string
  }>
  app: {
    legacyAppId: string
    destinationAppId: string
    resourceId: string
    status: 'active' | 'suspended' | 'undeployed'
    source: { provider: 'deepspace' } | { provider: 'github'; repository: string } | null
    sourceRevision: number
    deployedAt: string | null
    versionId: string | null
    hasSecretsStore: boolean
    sourceClaimRequired: boolean
  }
  rekey: {
    appRow: 1
    routes: Array<{
      host: string
      appId: string
      kind: 'subdomain' | 'custom'
      status: 'active' | 'released'
      claimedAt: string
      releasedAt: string | null
      releasedBy: string | null
    }>
    collaborators: Array<{ userId: string; addedAt: string; addedBy: string }>
    pendingCollaborators: Array<{
      email: string
      invitedBy: string
      createdAt: number
      expiresAt: number
    }>
    transfer: {
      fromUserId: string
      toUserId: string
      createdAt: string
      expiresAt: string
    } | null
  }
  retainedPhysicalStores: Array<{
    kind:
      | 'worker'
      | 'repo_and_releases'
      | 'secrets'
      | 'provisioned_bindings'
      | 'files_and_records'
      | 'logs_analytics_usage_billing'
    resourceId: string
    operation: 'retain'
  }>
}

export async function getIdentityMigration(
  deployUrl: string,
  token: string,
  appId: string,
): Promise<IdentityMigration | null> {
  try {
    const result = await apiFetch<{ migration: IdentityMigration }>(
      deployUrl,
      token,
      `/api/apps/${encodeURIComponent(appId)}/identity-migration`,
    )
    return result.migration
  } catch (error) {
    if (error instanceof ApiError && error.code === 'migration_not_found') return null
    throw error
  }
}

export async function prepareIdentityMigration(
  deployUrl: string,
  token: string,
  legacyAppId: string,
  input: {
    destinationAppId: string
    repository: string
    expectedSourceRevision: number
  },
): Promise<IdentityMigration> {
  const result = await apiFetch<{ migration: IdentityMigration }>(
    deployUrl,
    token,
    `/api/apps/${encodeURIComponent(legacyAppId)}/identity-migration/prepare`,
    { method: 'POST', body: JSON.stringify(input) },
  )
  return result.migration
}

export async function inspectIdentityMigration(
  deployUrl: string,
  token: string,
  legacyAppId: string,
  input: {
    destinationAppId: string
    repository: string
  },
): Promise<IdentityMigrationInventory> {
  const result = await apiFetch<{ inventory: IdentityMigrationInventory }>(
    deployUrl,
    token,
    `/api/apps/${encodeURIComponent(legacyAppId)}/identity-migration/inspect`,
    { method: 'POST', body: JSON.stringify(input) },
  )
  return result.inventory
}

export async function commitIdentityMigration(
  deployUrl: string,
  token: string,
  appId: string,
  input: { commitOid: string; branch: string },
): Promise<IdentityMigration> {
  const result = await apiFetch<{ migration: IdentityMigration }>(
    deployUrl,
    token,
    `/api/apps/${encodeURIComponent(appId)}/identity-migration/commit`,
    { method: 'POST', body: JSON.stringify(input) },
  )
  return result.migration
}

export async function cancelIdentityMigration(
  deployUrl: string,
  token: string,
  appId: string,
): Promise<void> {
  await apiFetch<{ ok: true }>(
    deployUrl,
    token,
    `/api/apps/${encodeURIComponent(appId)}/identity-migration`,
    { method: 'DELETE' },
  )
}

export async function verifyIdentityMigration(
  deployUrl: string,
  token: string,
  appId: string,
): Promise<IdentityMigration> {
  const result = await apiFetch<{ migration: IdentityMigration }>(
    deployUrl,
    token,
    `/api/apps/${encodeURIComponent(appId)}/identity-migration/verify`,
    { method: 'POST' },
  )
  return result.migration
}
