/**
 * deepspace test-accounts
 *
 * Manage test accounts for local development and CI.
 * Test accounts use @deepspace.test emails and are clearly
 * demarcated in the database. Max 10 per developer.
 *
 * Credentials are saved to ~/.deepspace/test-accounts.json (0600)
 * so they persist across projects and sessions.
 *
 *   deepspace test-accounts create --email bot@deepspace.test --password Pass123!
 *   deepspace test-accounts list
 *   deepspace test-accounts delete --email bot@deepspace.test
 *   deepspace test-accounts delete --id <id>
 *   deepspace test-accounts clear                # delete all (with confirm)
 *   deepspace test-accounts clear --label e2e    # delete only label=e2e
 *   deepspace test-accounts clear --yes          # skip confirm (CI)
 */

import { defineCommand } from 'citty'
import * as p from '@clack/prompts'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { ensureToken, SESSION_PATH } from '../auth'
import { PLATFORM_URLS } from '../env'

const SESSION_COOKIE = '__Secure-better-auth.session_token'

const AUTH_URL = process.env.DEEPSPACE_AUTH_URL ?? PLATFORM_URLS.auth
const DIR = join(homedir(), '.deepspace')
const ACCOUNTS_PATH = join(DIR, 'test-accounts.json')

// ── Local credential store ─────────────────────────────────────────

interface StoredAccount {
  id: string
  email: string
  password: string
  userId: string
  name?: string
  label?: string | null
  createdAt: number
}

function loadAccounts(): StoredAccount[] {
  if (!existsSync(ACCOUNTS_PATH)) return []
  try {
    return JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf-8'))
  } catch {
    return []
  }
}

function saveAccounts(accounts: StoredAccount[]) {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2), { mode: 0o600 })
}

// ── Helpers ────────────────────────────────────────────────────────

function sessionCookie(): string {
  const token = readFileSync(SESSION_PATH, 'utf-8').trim()
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`
}

interface RemoteAccount {
  id: string
  email: string
  userId: string
  label: string | null
  createdAt: number
}

async function fetchRemoteAccounts(): Promise<RemoteAccount[]> {
  const res = await fetch(`${AUTH_URL}/api/auth/test-accounts`, {
    headers: { Cookie: sessionCookie(), Origin: AUTH_URL },
  })
  const data = (await res.json().catch(() => ({}))) as {
    accounts?: RemoteAccount[]
    error?: string
  }
  if (!res.ok || !data.accounts) {
    throw new Error(data.error ?? 'Failed to list test accounts')
  }
  return data.accounts
}

async function deleteRemote(id: string): Promise<void> {
  const res = await fetch(`${AUTH_URL}/api/auth/test-accounts/${id}`, {
    method: 'DELETE',
    headers: { Cookie: sessionCookie(), Origin: AUTH_URL },
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `DELETE returned ${res.status}`)
  }
}

// ── Subcommands ────────────────────────────────────────────────────

const create = defineCommand({
  meta: {
    name: 'create',
    description: 'Create a test account',
  },
  args: {
    email: {
      type: 'string',
      description: 'Email (must end with @deepspace.test)',
      required: true,
    },
    password: {
      type: 'string',
      description: 'Password (min 8 characters)',
      required: true,
    },
    name: {
      type: 'string',
      description: 'Display name',
      required: false,
    },
    label: {
      type: 'string',
      description: 'Label for this test account',
      required: false,
    },
  },
  async run({ args }) {
    await ensureToken()

    const res = await fetch(`${AUTH_URL}/api/auth/test-accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie(),
        Origin: AUTH_URL,
      },
      body: JSON.stringify({
        email: args.email,
        password: args.password,
        name: args.name,
        label: args.label,
      }),
    })

    const data = (await res.json().catch(() => ({}))) as {
      id?: string
      email?: string
      userId?: string
      label?: string | null
      createdAt?: number
      error?: string
    }

    if (!res.ok || !data.id) {
      console.error(`Failed: ${data.error ?? 'Unknown error'}`)
      process.exit(1)
    }

    const account = data as {
      id: string
      email: string
      userId: string
      label: string | null
      createdAt: number
    }

    // Save credentials locally
    const accounts = loadAccounts()
    accounts.push({
      id: account.id,
      email: args.email,
      password: args.password,
      userId: account.userId,
      name: args.name,
      label: account.label,
      createdAt: account.createdAt,
    })
    saveAccounts(accounts)

    console.log(`Created test account:`)
    console.log(`  ID:       ${account.id}`)
    console.log(`  Email:    ${account.email}`)
    console.log(`  Password: ${args.password}`)
    console.log(`  UserID:   ${account.userId}`)
    if (account.label) console.log(`  Label:    ${account.label}`)
    console.log(`\nSaved to ${ACCOUNTS_PATH}`)
  },
})

const list = defineCommand({
  meta: {
    name: 'list',
    description: 'List your test accounts',
  },
  async run() {
    await ensureToken()

    let remote: RemoteAccount[]
    try {
      remote = await fetchRemoteAccounts()
    } catch (err) {
      console.error(`Failed: ${(err as Error).message}`)
      process.exit(1)
    }

    if (remote.length === 0) {
      console.log(
        'No test accounts. Create one with: deepspace test-accounts create --email <email> --password <password>',
      )
      return
    }

    // Merge with local credentials (passwords are only stored locally)
    const local = loadAccounts()
    const localByEmail = new Map(local.map((a) => [a.email, a]))

    console.log(`Test accounts (${remote.length}/10):\n`)
    for (const a of remote) {
      const stored = localByEmail.get(a.email)
      const date = new Date(a.createdAt).toLocaleDateString()
      console.log(`  ${a.email}${a.label ? ` (${a.label})` : ''}`)
      console.log(`    ID: ${a.id}  UserID: ${a.userId}  Created: ${date}`)
      if (stored?.password) {
        console.log(`    Password: ${stored.password}`)
      } else {
        console.log(`    Password: (not saved locally)`)
      }
    }
  },
})

const del = defineCommand({
  meta: {
    name: 'delete',
    description: 'Delete a test account by --email or --id',
  },
  args: {
    email: {
      type: 'string',
      description: 'Email of the test account to delete',
      required: false,
    },
    id: {
      type: 'string',
      description: 'ID of the test account to delete',
      required: false,
    },
  },
  async run({ args }) {
    if (!args.email && !args.id) {
      console.error('Provide --email <email> or --id <id>.')
      process.exit(1)
    }
    if (args.email && args.id) {
      console.error('Provide either --email or --id, not both.')
      process.exit(1)
    }

    await ensureToken()

    let targetId = args.id as string | undefined
    const targetEmail = args.email as string | undefined

    if (targetEmail && !targetId) {
      let remote: RemoteAccount[]
      try {
        remote = await fetchRemoteAccounts()
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`)
        process.exit(1)
      }
      const match = remote.find((a) => a.email === targetEmail)
      if (!match) {
        console.error(`No test account with email ${targetEmail}.`)
        process.exit(1)
      }
      targetId = match.id
    }

    try {
      await deleteRemote(targetId!)
    } catch (err) {
      console.error(`Failed: ${(err as Error).message}`)
      process.exit(1)
    }

    // Remove from local store
    const accounts = loadAccounts().filter(
      (a) => a.id !== targetId && (!targetEmail || a.email !== targetEmail),
    )
    saveAccounts(accounts)

    console.log(`Test account deleted${targetEmail ? `: ${targetEmail}` : `: ${targetId}`}`)
  },
})

const clear = defineCommand({
  meta: {
    name: 'clear',
    description: 'Delete all your test accounts (or those matching --label)',
  },
  args: {
    label: {
      type: 'string',
      description: 'Only delete accounts with this label (e.g. e2e, slack-clone)',
      required: false,
    },
    yes: {
      type: 'boolean',
      description: 'Skip confirmation prompt (for CI scripts)',
      default: false,
    },
  },
  async run({ args }) {
    await ensureToken()

    let remote: RemoteAccount[]
    try {
      remote = await fetchRemoteAccounts()
    } catch (err) {
      console.error(`Failed: ${(err as Error).message}`)
      process.exit(1)
    }

    const targets = args.label ? remote.filter((a) => a.label === args.label) : remote

    if (targets.length === 0) {
      const suffix = args.label ? ` with label '${args.label}'` : ''
      console.log(`No test accounts${suffix} to delete.`)
      return
    }

    if (!args.yes) {
      const subject = args.label
        ? `${targets.length} test account(s) labeled '${args.label}'`
        : `all ${targets.length} test account(s)`
      const confirmed = await p.confirm({
        message: `Delete ${subject}? This is not reversible.`,
        initialValue: false,
      })
      if (p.isCancel(confirmed) || !confirmed) {
        console.log('Cancelled.')
        return
      }
    }

    let ok = 0
    const failures: Array<{ email: string; error: string }> = []
    for (const a of targets) {
      try {
        await deleteRemote(a.id)
        ok++
      } catch (err) {
        failures.push({ email: a.email, error: (err as Error).message })
      }
    }

    // Sync local store with what's actually deleted.
    const deletedIds = new Set(
      targets.filter((t) => !failures.find((f) => f.email === t.email)).map((t) => t.id),
    )
    saveAccounts(loadAccounts().filter((a) => !deletedIds.has(a.id)))

    console.log(`Deleted ${ok}/${targets.length} test account(s).`)
    if (failures.length > 0) {
      console.error(`\nFailed:`)
      for (const f of failures) console.error(`  ${f.email}: ${f.error}`)
      process.exit(1)
    }
  },
})

export default defineCommand({
  meta: {
    name: 'test-accounts',
    description: 'Manage test accounts for development',
  },
  subCommands: {
    create,
    list,
    delete: del,
    clear,
  },
})
