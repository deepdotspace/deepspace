/**
 * Account-credential plumbing for the testing module.
 *
 * Reads test accounts from the auth-origin-scoped registry at
 * `~/.deepspace/test-accounts.json` (the same file
 * `deepspace test accounts create` writes). Persisted accounts are bound to a
 * remote account id; `name` and `label` are optional.
 *
 * Used by the multi-user Playwright fixture in `./fixtures.ts` and is
 * also exported standalone in case suites want to do their own
 * orchestration.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
// Node-only leaf (its only import is `node:fs`), and this module is Node-only
// too — Playwright fixtures. Reusing it keeps one definition of "write a file
// holding plaintext secrets" rather than a second hand-rolled copy here.
import { writeSecretFileSync } from '../cli/lib/secure-file'

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
  const selected =
    env.DEEPSPACE_AUTH_URL ??
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
  return store.scopes[scope] ?? []
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
  const accounts = reconcileTestAccounts(scoped, remote)
  return {
    accounts,
    removed: Math.max(0, scoped.length - accounts.length),
    store: {
      version: 2,
      scopes: { ...store.scopes, [scope]: accounts },
    },
  }
}

export function reconcileTestAccounts(
  local: TestAccount[],
  remote: RemoteTestAccount[],
): TestAccount[] {
  const localById = new Map(
    local.filter((account) => account.id).map((account) => [account.id, account]),
  )
  return remote.flatMap((account) => {
    const stored = localById.get(account.id)
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
  })
}

function readTestAccountStore(): TestAccountCredentialStore {
  if (!existsSync(TEST_ACCOUNTS_PATH)) return { version: 2, scopes: {} }
  try {
    const raw: unknown = JSON.parse(readFileSync(TEST_ACCOUNTS_PATH, 'utf-8'))
    if (Array.isArray(raw)) return { version: 2, scopes: {} }
    if (!raw || typeof raw !== 'object') {
      return { version: 2, scopes: {} }
    }
    const candidate = raw as { scopes?: unknown }
    const scopes =
      candidate.scopes && typeof candidate.scopes === 'object' && !Array.isArray(candidate.scopes)
        ? Object.fromEntries(
            Object.entries(candidate.scopes).map(([key, value]) => [key, validTestAccounts(value)]),
          )
        : {}
    return { version: 2, scopes }
  } catch {
    return { version: 2, scopes: {} }
  }
}

function validTestAccounts(value: unknown): TestAccount[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is TestAccount =>
    Boolean(
      item &&
      typeof item === 'object' &&
      typeof (item as TestAccount).id === 'string' &&
      typeof (item as TestAccount).email === 'string' &&
      typeof (item as TestAccount).password === 'string',
    ),
  )
}

function saveTestAccountStore(store: TestAccountCredentialStore): void {
  mkdirSync(join(homedir(), '.deepspace'), { recursive: true })
  // Holds plaintext passwords, so it must end up 0600 even when the file
  // already exists with a wider mode — `writeFileSync`'s `mode` applies only
  // at creation, which would silently leave a pre-existing world-readable
  // file world-readable while writing fresh credentials into it.
  writeSecretFileSync(TEST_ACCOUNTS_PATH, JSON.stringify(store, null, 2))
}

/**
 * Pick `count` test accounts from the local registry, optionally
 * filtered by `label`. Order-stable: sorted by `createdAt` ascending so
 * the first test account you created is always the first one returned.
 *
 * Throws with a helpful message if not enough accounts exist.
 */
export function pickTestAccounts(count: number, options?: { label?: string }): TestAccount[] {
  const all = loadAllTestAccounts()
  const filtered = options?.label ? all.filter((a) => a.label === options.label) : all
  const sorted = filtered.slice().sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))

  if (sorted.length < count) {
    const labelHint = options?.label ? ` (label="${options.label}")` : ''
    throw new Error(
      `Multiplayer test needs ${count} test accounts${labelHint}, but only ${sorted.length} ` +
        `are usable from ${TEST_ACCOUNTS_PATH}.\n` +
        `The pool is global per developer, but passwords are stored only on the machine that ` +
        `created the account — so accounts created elsewhere are listed by ` +
        `\`deepspace test accounts list\` and count against the 10-cap, yet cannot be signed in ` +
        `as here. Re-issue their credentials, or create more:\n` +
        `  deepspace test accounts recover --all (note: --all only covers accounts missing a local credential; recover a stale one by its email)\n` +
        `  deepspace test accounts create --email <name>@deepspace.test --password <pw> --name "<name>"${
          options?.label ? ` --label ${options.label}` : ''
        }`,
    )
  }

  return sorted.slice(0, count)
}

/**
 * Turn a display name into the local-part of a test-account email.
 * "Collab A" -> "collab-a". Without this the suggested command in the
 * not-found error carried a space inside the address and could not be run.
 */
export function testAccountEmailSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'tester'
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
      `No test account named "${name}" is usable from ${TEST_ACCOUNTS_PATH}.\n` +
        `If it exists in the pool but was created on another machine, its password is not ` +
        `stored here — re-issue it:\n` +
        `  deepspace test accounts recover --all (note: --all only covers accounts missing a local credential; recover a stale one by its email)\n` +
        `Otherwise create it:\n` +
        `  deepspace test accounts create --email ${testAccountEmailSlug(name)}@deepspace.test --password <pw> --name "${name}"\n` +
        `Suites that do not depend on a specific identity should ask for any N accounts with ` +
        `\`users(2)\` instead of naming them.`,
    )
  }
  return match
}
