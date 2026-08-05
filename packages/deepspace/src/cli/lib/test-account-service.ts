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
