import { readFileSync } from 'node:fs'
import {
  normalizeTestAccountScope,
  reconcileTestAccountStore,
  type RemoteTestAccount,
} from '../../testing/accounts'
import { SESSION_PATH } from '../auth'
import { PLATFORM_URLS } from '../env'

const SESSION_COOKIE = '__Secure-better-auth.session_token'
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
  }
  if (!response.ok || !data.accounts) {
    throw new Error(data.error ?? 'Failed to list test accounts')
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
  const data = await response.json().catch(() => ({})) as Partial<RemoteTestAccount> & { error?: string }
  if (
    !response.ok ||
    typeof data.id !== 'string' ||
    typeof data.email !== 'string' ||
    typeof data.userId !== 'string' ||
    typeof data.createdAt !== 'number'
  ) {
    throw new Error(data.error ?? 'Unknown error')
  }
  return { ...data, label: data.label ?? null } as RemoteTestAccount
}

export interface RecoveredTestAccount extends RemoteTestAccount {
  password: string
  /** Better Auth display name, joined in by the rotate endpoint. Null when the
   *  account has none; absent from a platform older than that join. */
  name?: string | null
}

/**
 * Rotate a test account's password to a fresh platform-generated one and
 * return it, so an account created on another machine becomes usable here.
 * The platform stores no recoverable plaintext, so recovery is a rotation —
 * any other machine holding the old password must recover too.
 */
export async function recoverRemoteTestAccount(id: string): Promise<RecoveredTestAccount> {
  const response = await fetch(`${AUTH_URL}/api/auth/test-accounts/${id}/credential`, {
    method: 'POST',
    headers: { Cookie: sessionCookie(), Origin: AUTH_URL },
  })
  const data = await response.json().catch(() => ({})) as Partial<RecoveredTestAccount> & {
    error?: string
  }
  if (response.status === 404) {
    throw new Error(
      `No test account ${id} on this account. Run \`deepspace test accounts list\` for the current pool.`,
    )
  }
  if (
    !response.ok ||
    typeof data.password !== 'string' ||
    typeof data.email !== 'string' ||
    typeof data.userId !== 'string'
  ) {
    throw new Error(data.error ?? 'Failed to re-issue the test account credential')
  }
  return {
    id,
    email: data.email,
    userId: data.userId,
    label: data.label ?? null,
    name: typeof data.name === 'string' ? data.name : null,
    createdAt: data.createdAt ?? Date.now(),
    password: data.password,
  }
}

export async function deleteRemoteTestAccount(id: string): Promise<void> {
  const response = await fetch(`${AUTH_URL}/api/auth/test-accounts/${id}`, {
    method: 'DELETE',
    headers: { Cookie: sessionCookie(), Origin: AUTH_URL },
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error ?? `DELETE returned ${response.status}`)
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
