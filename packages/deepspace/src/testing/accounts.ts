/**
 * Account-credential plumbing for the testing module.
 *
 * Reads test accounts from `~/.deepspace/test-accounts.json` (the same
 * file `deepspace test-accounts create` writes). Each account has at
 * minimum `{email, password}`; `name` and `label` are optional.
 *
 * Used by the multi-user Playwright fixture in `./fixtures.ts` and is
 * also exported standalone in case suites want to do their own
 * orchestration.
 */

import { existsSync, readFileSync } from 'node:fs'
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

const ACCOUNTS_PATH = join(homedir(), '.deepspace', 'test-accounts.json')

/**
 * Load all test accounts the developer has created. Returns an empty
 * array if the file doesn't exist yet.
 */
export function loadAllTestAccounts(): TestAccount[] {
  if (!existsSync(ACCOUNTS_PATH)) return []
  try {
    const raw = JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf-8'))
    if (!Array.isArray(raw)) return []
    // Filter out any malformed entries (missing email or password). Keep
    // bare {email, password} rows so the file format stays forgiving.
    return raw.filter(
      (r) => r && typeof r.email === 'string' && typeof r.password === 'string',
    )
  } catch {
    return []
  }
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
        `are present in ${ACCOUNTS_PATH}. Create more with:\n` +
        `  deepspace test-accounts create --email <name>@deepspace.test --password <pw> --name "<name>"${
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
      `No test account named "${name}" in ${ACCOUNTS_PATH}. Create with:\n` +
        `  deepspace test-accounts create --email ${name.toLowerCase()}@deepspace.test --password <pw> --name "${name}"`,
    )
  }
  return match
}
