/**
 * Account-credential plumbing for the testing module.
 *
 * Reads test accounts from the auth-origin-scoped registry at
 * `~/.deepspace/test-accounts.json` (the same file
 * `deepspace test accounts create` writes). Each account has at minimum
 * `{email, password}`; `name` and `label` are optional.
 *
 * Used by the multi-user Playwright fixture in `./fixtures.ts` and is
 * also exported standalone in case suites want to do their own
 * orchestration.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface TestAccount {
  email: string
  password: string
  name?: string
  label?: string | null
  id?: string
  userId?: string
  createdAt?: number
}

export const TEST_ACCOUNTS_PATH = join(homedir(), '.deepspace', 'test-accounts.json')

const PRODUCTION_AUTH_ORIGIN = 'https://auth.deep.space'
const STAGING_AUTH_ORIGIN = 'https://auth.deepspacesites.com'

export interface TestAccountCredentialStore {
  version: 2
  scopes: Record<string, TestAccount[]>
  /** Legacy credentials stay here until a remote id proves their plane. */
  unscoped: TestAccount[]
}

export interface RemoteTestAccount {
  id: string
  email: string
  userId: string
  label: string | null
  createdAt: number
}

/**
 * Load all test accounts the developer has created. Returns an empty
 * array if the file doesn't exist yet.
 */
export function currentTestAccountScope(env: NodeJS.ProcessEnv = process.env): string {
  const selected = env.DEEPSPACE_AUTH_URL ??
    (env.DEEPSPACE_ENV === 'staging' ? STAGING_AUTH_ORIGIN : PRODUCTION_AUTH_ORIGIN)
  return normalizeTestAccountScope(selected)
}

export function normalizeTestAccountScope(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    return value
  }
}

export function loadAllTestAccounts(scope = currentTestAccountScope()): TestAccount[] {
  const store = readTestAccountStore()
  return mergeTestAccounts(store.scopes[scope] ?? [], store.unscoped)
}

/**
 * Replace the local credential registry with the subset that still exists
 * remotely. Passwords and display names remain local-only; a recreated email
 * with a different id is deliberately treated as a different account.
 */
export function reconcileTestAccountStore(
  remote: RemoteTestAccount[],
  scope = currentTestAccountScope(),
): {
  accounts: TestAccount[]
  removed: number
} {
  const result = reconcileTestAccountScopes(readTestAccountStore(), remote, scope)
  saveTestAccountStore(result.store)
  return { accounts: result.accounts, removed: result.removed }
}

export function reconcileTestAccountScopes(
  store: TestAccountCredentialStore,
  remote: RemoteTestAccount[],
  scope: string,
): { store: TestAccountCredentialStore; accounts: TestAccount[]; removed: number } {
  const scoped = store.scopes[scope] ?? []
  const current = reconcileTestAccounts(scoped, remote)
  const migrated = reconcileTestAccounts(store.unscoped, remote)
  const accounts = mergeTestAccounts(current, migrated)
  return {
    accounts,
    removed: Math.max(0, scoped.length - current.length),
    store: {
      version: 2,
      scopes: { ...store.scopes, [scope]: accounts },
      unscoped: store.unscoped.filter((account) => !remote.some((item) => accountMatchesRemote(account, item))),
    },
  }
}

export function reconcileTestAccounts(
  local: TestAccount[],
  remote: RemoteTestAccount[],
): TestAccount[] {
  const localById = new Map(local.filter((account) => account.id).map((account) => [account.id, account]))
  const legacyByEmail = new Map(local.filter((account) => !account.id).map((account) => [account.email, account]))
  return remote.flatMap((account) => {
    const stored = localById.get(account.id) ?? legacyByEmail.get(account.email)
    return stored ? [{ ...stored, ...account }] : []
  })
}

/** Add or replace one locally stored credential without creating duplicates. */
export function upsertTestAccount(account: TestAccount, scope = currentTestAccountScope()): void {
  const store = readTestAccountStore()
  const accounts = (store.scopes[scope] ?? []).filter(
    (stored) => stored.id !== account.id && stored.email !== account.email,
  )
  saveTestAccountStore({
    version: 2,
    scopes: { ...store.scopes, [scope]: [...accounts, account] },
    unscoped: store.unscoped.filter(
      (stored) => stored.id !== account.id && stored.email !== account.email,
    ),
  })
}

/** Remove credentials after the corresponding remote delete succeeds. */
export function removeTestAccounts(
  ids: string[],
  emails: string[] = [],
  scope = currentTestAccountScope(),
): void {
  const idSet = new Set(ids)
  const emailSet = new Set(emails)
  const keep = (account: TestAccount): boolean =>
    !idSet.has(account.id ?? '') && !emailSet.has(account.email)
  const store = readTestAccountStore()
  saveTestAccountStore({
    version: 2,
    scopes: { ...store.scopes, [scope]: (store.scopes[scope] ?? []).filter(keep) },
    unscoped: store.unscoped.filter(keep),
  })
}

function readTestAccountStore(): TestAccountCredentialStore {
  if (!existsSync(TEST_ACCOUNTS_PATH)) return { version: 2, scopes: {}, unscoped: [] }
  try {
    const raw: unknown = JSON.parse(readFileSync(TEST_ACCOUNTS_PATH, 'utf-8'))
    if (Array.isArray(raw)) return { version: 2, scopes: {}, unscoped: validTestAccounts(raw) }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { version: 2, scopes: {}, unscoped: [] }
    }
    const candidate = raw as { scopes?: unknown; unscoped?: unknown }
    const scopes = candidate.scopes && typeof candidate.scopes === 'object' && !Array.isArray(candidate.scopes)
      ? Object.fromEntries(Object.entries(candidate.scopes).map(([key, value]) => [key, validTestAccounts(value)]))
      : {}
    return { version: 2, scopes, unscoped: validTestAccounts(candidate.unscoped) }
  } catch {
    return { version: 2, scopes: {}, unscoped: [] }
  }
}

function validTestAccounts(value: unknown): TestAccount[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is TestAccount => Boolean(
    item && typeof item === 'object' &&
    typeof (item as TestAccount).email === 'string' &&
    typeof (item as TestAccount).password === 'string',
  ))
}

function mergeTestAccounts(...groups: TestAccount[][]): TestAccount[] {
  const accounts = new Map<string, TestAccount>()
  for (const account of groups.flat()) {
    const key = account.id ? `id:${account.id}` : `email:${account.email}`
    if (!accounts.has(key)) accounts.set(key, account)
  }
  return [...accounts.values()]
}

function accountMatchesRemote(local: TestAccount, remote: RemoteTestAccount): boolean {
  return local.id ? local.id === remote.id : local.email === remote.email
}

function saveTestAccountStore(store: TestAccountCredentialStore): void {
  mkdirSync(join(homedir(), '.deepspace'), { recursive: true })
  writeFileSync(TEST_ACCOUNTS_PATH, JSON.stringify(store, null, 2), { mode: 0o600 })
}

/**
 * Pick `count` test accounts from the local registry, optionally
 * filtered by `label`. Order-stable: sorted by `createdAt` ascending so
 * the first test account you created is always the first one returned.
 *
 * Throws with a helpful message if not enough accounts exist.
 */
export function pickTestAccounts(
  count: number,
  options?: { label?: string },
): TestAccount[] {
  const all = loadAllTestAccounts()
  const filtered = options?.label
    ? all.filter((a) => a.label === options.label)
    : all
  const sorted = filtered.slice().sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))

  if (sorted.length < count) {
    const labelHint = options?.label ? ` (label="${options.label}")` : ''
    throw new Error(
      `Multiplayer test needs ${count} test accounts${labelHint}, but only ${sorted.length} ` +
        `are present in ${TEST_ACCOUNTS_PATH}. Create more with:\n` +
        `  deepspace test accounts create --email <name>@deepspace.test --password <pw> --name "<name>"${
          options?.label ? ` --label ${options.label}` : ''
        }`,
    )
  }

  return sorted.slice(0, count)
}

/**
 * Find a single account by name. Used by `users(['Alice', 'Bob'])`.
 * Throws if not found.
 */
export function findTestAccountByName(name: string): TestAccount {
  const all = loadAllTestAccounts()
  const match = all.find((a) => a.name === name)
  if (!match) {
    throw new Error(
      `No test account named "${name}" in ${TEST_ACCOUNTS_PATH}. Create with:\n` +
        `  deepspace test accounts create --email ${name.toLowerCase()}@deepspace.test --password <pw> --name "${name}"`,
    )
  }
  return match
}
