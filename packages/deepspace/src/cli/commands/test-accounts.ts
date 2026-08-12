/**
 * deepspace test accounts
 *
 * Manage test accounts for local development and CI.
 * Test accounts use @deepspace.test emails and are clearly
 * demarcated in the database. Max 10 per developer.
 *
 * Credentials are saved to ~/.deepspace/test-accounts.json (0600)
 * so they persist across projects and sessions.
 *
 *   deepspace test accounts create --email bot@deepspace.test --password Pass123!
 *   deepspace test accounts list
 *   deepspace test accounts delete --email bot@deepspace.test
 *   deepspace test accounts delete --id <id>
 *   deepspace test accounts clear                # delete all (with confirm)
 *   deepspace test accounts clear --label e2e    # delete only label=e2e
 *   deepspace test accounts clear --yes          # skip confirm (CI)
 */

import { defineCommand } from 'citty'
import * as p from '@clack/prompts'
import { ensureToken } from '../auth'
import { cliAction, defineDeepspaceCommand, Refusal } from '../lib/command'
import {
  createRemoteTestAccount,
  deleteRemoteTestAccount,
  fetchRemoteTestAccounts,
  syncTestAccountStore,
} from '../lib/test-account-service'
import {
  loadAllTestAccounts,
  removeTestAccounts,
  TEST_ACCOUNTS_PATH,
  upsertTestAccount,
  type RemoteTestAccount,
} from '../../testing/accounts'

// ── Subcommands ────────────────────────────────────────────────────

const create = defineDeepspaceCommand({
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
    const email = args.email as string
    const password = args.password as string
    const name = args.name as string | undefined
    const label = args.label as string | undefined

    let account: RemoteTestAccount
    try {
      account = await createRemoteTestAccount({ email, password, name, label })
    } catch (error) {
      throw new Refusal(
        `Failed: ${error instanceof Error ? error.message : String(error)}`,
        'test_account_create_failed',
      )
    }

    // Save credentials locally
    upsertTestAccount({
      id: account.id,
      email,
      password,
      userId: account.userId,
      name,
      label: account.label,
      createdAt: account.createdAt,
    })

    if (!args.json) {
      console.log(`Created test account:`)
      console.log(`  ID:       ${account.id}`)
      console.log(`  Email:    ${account.email}`)
      console.log(`  Password: ${password}`)
      console.log(`  UserID:   ${account.userId}`)
      if (account.label) console.log(`  Label:    ${account.label}`)
      console.log(`\nSaved to ${TEST_ACCOUNTS_PATH}`)
    }

    return {
      data: {
        id: account.id,
        email: account.email,
        // The password is already echoed on the human path and stored 0600 in
        // ACCOUNTS_PATH — withholding it from --json would only force scripts
        // to parse the file themselves.
        password,
        userId: account.userId,
        label: account.label ?? null,
        createdAt: account.createdAt,
        savedTo: TEST_ACCOUNTS_PATH,
      },
    }
  },
})

const list = defineDeepspaceCommand({
  meta: {
    name: 'list',
    description: 'List your test accounts',
  },
  async run({ args }) {
    await ensureToken()

    let remote: RemoteTestAccount[]
    try {
      remote = (await syncTestAccountStore()).accounts
    } catch (err) {
      throw new Refusal(`Failed: ${(err as Error).message}`, 'test_accounts_list_failed')
    }

    // Merge with local credentials (passwords are only stored locally)
    const local = loadAllTestAccounts()
    const localByEmail = new Map(local.map((a) => [a.email, a]))

    if (remote.length === 0) {
      if (!args.json) {
        console.log(
          'No test accounts. Create one with: deepspace test accounts create --email <email> --password <password>',
        )
      }
      return { data: { accounts: [], count: 0, limit: 10 } }
    }

    if (!args.json) {
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
    }

    return {
      data: {
        accounts: remote.map((a) => ({
          id: a.id,
          email: a.email,
          userId: a.userId,
          label: a.label,
          createdAt: a.createdAt,
          password: localByEmail.get(a.email)?.password ?? null,
        })),
        count: remote.length,
        limit: 10,
      },
    }
  },
})

const del = defineDeepspaceCommand({
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
      throw new Refusal('Provide --email <email> or --id <id>.', 'missing_argument')
    }
    if (args.email && args.id) {
      throw new Refusal('Provide either --email or --id, not both.', 'conflicting_arguments')
    }

    await ensureToken()

    let targetId = args.id as string | undefined
    const targetEmail = args.email as string | undefined

    if (targetEmail && !targetId) {
      let remote: RemoteTestAccount[]
      try {
        remote = await fetchRemoteTestAccounts()
      } catch (err) {
        throw new Refusal(`Failed: ${(err as Error).message}`, 'test_accounts_list_failed')
      }
      const match = remote.find((a) => a.email === targetEmail)
      if (!match) {
        throw new Refusal(`No test account with email ${targetEmail}.`, 'test_account_not_found', {
          action: cliAction('deepspace', 'test', 'accounts', 'list'),
        })
      }
      targetId = match.id
    }

    try {
      await deleteRemoteTestAccount(targetId!)
    } catch (err) {
      throw new Refusal(`Failed: ${(err as Error).message}`, 'test_account_delete_failed')
    }

    // Remove from local store
    removeTestAccounts([targetId!], targetEmail ? [targetEmail] : [])

    if (!args.json) {
      console.log(`Test account deleted${targetEmail ? `: ${targetEmail}` : `: ${targetId}`}`)
    }
    return { data: { deleted: true, id: targetId ?? null, email: targetEmail ?? null } }
  },
})

const clear = defineDeepspaceCommand({
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
    const label = args.label as string | undefined
    await ensureToken()

    let remote: RemoteTestAccount[]
    try {
      remote = await fetchRemoteTestAccounts()
    } catch (err) {
      throw new Refusal(`Failed: ${(err as Error).message}`, 'test_accounts_list_failed')
    }

    const targets = label ? remote.filter((a) => a.label === label) : remote

    if (targets.length === 0) {
      const suffix = label ? ` with label '${label}'` : ''
      if (!args.json) console.log(`No test accounts${suffix} to delete.`)
      return { data: { deleted: 0, requested: 0, failures: [] } }
    }

    if (!args.yes) {
      // p.confirm needs a TTY it can prompt on. A `--json` caller is a script by
      // definition, and a piped stdin (agent, `printf 'y' |`) is no better:
      // clack resolves off the pipe, but its paused pipe stays a ref'd open
      // handle that hangs the naturally-exiting process AFTER the accounts are
      // deleted. Refuse with the flag that resolves it instead of hanging
      // (same gate as transfer.ts).
      if (!process.stdin.isTTY || args.json) {
        throw new Refusal(
          'Deleting test accounts needs confirmation. Pass --yes to confirm non-interactively.',
          'confirmation_required',
        )
      }
      const subject = label
        ? `${targets.length} test account(s) labeled '${label}'`
        : `all ${targets.length} test account(s)`
      const confirmed = await p.confirm({
        message: `Delete ${subject}? This is not reversible.`,
        initialValue: false,
      })
      if (p.isCancel(confirmed) || !confirmed) {
        console.log('Cancelled.')
        return { data: { deleted: 0, requested: targets.length, cancelled: true, failures: [] } }
      }
    }

    let ok = 0
    const failures: Array<{ email: string; error: string }> = []
    for (const a of targets) {
      try {
        await deleteRemoteTestAccount(a.id)
        ok++
      } catch (err) {
        failures.push({ email: a.email, error: (err as Error).message })
      }
    }

    // Sync local store with what's actually deleted.
    const deleted = targets.filter((target) => !failures.some((failure) => failure.email === target.email))
    removeTestAccounts(deleted.map((target) => target.id), deleted.map((target) => target.email))

    if (failures.length > 0) {
      // A partial delete still failed overall — carry the per-account reasons
      // in the refusal so --json reports them instead of only the count.
      throw new Refusal(
        `Deleted ${ok}/${targets.length} test account(s).\nFailed:\n` +
          failures.map((f) => `  ${f.email}: ${f.error}`).join('\n'),
        'test_account_delete_failed',
        { extra: { deleted: ok, requested: targets.length, failures } },
      )
    }
    if (!args.json) console.log(`Deleted ${ok}/${targets.length} test account(s).`)
    return { data: { deleted: ok, requested: targets.length, failures: [] } }
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
