import { readFileSync } from 'node:fs'
import {
  normalizeTestAccountScope,
  reconcileTestAccountStore,
  type RemoteTestAccount,
} from '../../testing/accounts'
import { SESSION_PATH } from '../auth'
import { PLATFORM_URLS } from '../env'

const SESSION_COOKIE = '__Secure-better-auth.session_token'

/** A platform refusal that carried a machine `code` (newer auth-workers put
 *  one beside `error`); callers key remedies on the code and fall back to
 *  message regexes only for a platform older than the codes. */
export class TestAccountServiceError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

function serviceError(data: { error?: string; code?: string }, fallback: string): TestAccountServiceError {
  return new TestAccountServiceError(data.error ?? fallback, data.code)
}
const AUTH_URL = process.env.DEEPSPACE_AUTH_URL ?? PLATFORM_URLS.auth

export interface CreateRemoteTestAccountInput {
  email: string
  password: string
  name?: string
  label?: string
}

function sessionCookie(): string {
  const token = readFileSync(SESSION_PATH, 'utf-8').trim()
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`
}

export async function fetchRemoteTestAccounts(): Promise<RemoteTestAccount[]> {
  const response = await fetch(`${AUTH_URL}/api/auth/test-accounts`, {
    headers: { Cookie: sessionCookie(), Origin: AUTH_URL },
  })
  const data = await response.json().catch(() => ({})) as {
    accounts?: RemoteTestAccount[]
    error?: string
    code?: string
  }
  if (!response.ok || !data.accounts) {
    throw serviceError(data, 'Failed to list test accounts')
  }
  return data.accounts
}

export async function createRemoteTestAccount(
  input: CreateRemoteTestAccountInput,
): Promise<RemoteTestAccount> {
  const response = await fetch(`${AUTH_URL}/api/auth/test-accounts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie(),
      Origin: AUTH_URL,
    },
    body: JSON.stringify(input),
  })
  const data = await response.json().catch(() => ({})) as Partial<RemoteTestAccount> & {
    error?: string
    code?: string
  }
  if (
    !response.ok ||
    typeof data.id !== 'string' ||
    typeof data.email !== 'string' ||
    typeof data.userId !== 'string' ||
    typeof data.createdAt !== 'number'
  ) {
    throw serviceError(data, 'Unknown error')
  }
  return { ...data, label: data.label ?? null } as RemoteTestAccount
}

export interface RecoveredTestAccount extends RemoteTestAccount {
  password: string
  /** Better Auth display name, joined in by the credential endpoint. Null when
   *  the account has none; absent from a platform older than that join. */
  name?: string | null
  /** True when the platform had no stored credential (a row predating the
   *  stored-credential column) and rotated to a fresh password — the ONE
   *  case where other machines' copies stop working. */
  rotated?: boolean
}

/**
 * Fetch a test account's credential so an account created on another machine
 * becomes usable here. The platform stores the plaintext for these synthetic
 * QA identities, so recovery is a plain RETRIEVAL — except for accounts
 * created before the credential was stored, which rotate once (`rotated`)
 * and are retrievals from then on.
 */
export async function recoverRemoteTestAccount(id: string): Promise<RecoveredTestAccount> {
  const response = await fetch(`${AUTH_URL}/api/auth/test-accounts/${id}/credential`, {
    method: 'POST',
    headers: { Cookie: sessionCookie(), Origin: AUTH_URL },
  })
  const data = await response.json().catch(() => ({})) as Partial<RecoveredTestAccount> & {
    error?: string
    code?: string
  }
  if (response.status === 404) {
    throw new TestAccountServiceError(
      `No test account ${id} on this account. Run \`deepspace test accounts list\` for the current pool.`,
      data.code ?? 'test_account_not_found',
    )
  }
  if (
    !response.ok ||
    typeof data.password !== 'string' ||
    typeof data.email !== 'string' ||
    typeof data.userId !== 'string'
  ) {
    throw serviceError(data, 'Failed to recover the test account credential')
  }
  return {
    id,
    email: data.email,
    userId: data.userId,
    label: data.label ?? null,
    name: typeof data.name === 'string' ? data.name : null,
    createdAt: data.createdAt ?? Date.now(),
    password: data.password,
    rotated: data.rotated === true,
  }
}

export async function deleteRemoteTestAccount(id: string): Promise<void> {
  const response = await fetch(`${AUTH_URL}/api/auth/test-accounts/${id}`, {
    method: 'DELETE',
    headers: { Cookie: sessionCookie(), Origin: AUTH_URL },
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string; code?: string }
    throw serviceError(data, `DELETE returned ${response.status}`)
  }
}

export async function syncTestAccountStore(): Promise<{
  accounts: RemoteTestAccount[]
  removed: number
}> {
  const accounts = await fetchRemoteTestAccounts()
  const { removed } = reconcileTestAccountStore(accounts, normalizeTestAccountScope(AUTH_URL))
  return { accounts, removed }
}
