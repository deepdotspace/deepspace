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
 *   printf %s "$PW" | deepspace test accounts create --email bot@deepspace.test --password-stdin
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
import { MAX_STDIN_BYTES, readStreamText } from '../lib/stdio'
import {
  createRemoteTestAccount,
  deleteRemoteTestAccount,
  fetchRemoteTestAccounts,
  recoverRemoteTestAccount,
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
      description: 'Password (min 8 characters). Prefer --password-stdin — argv is visible in `ps` and shell history',
      required: false,
    },
    'password-stdin': {
      type: 'boolean',
      description: 'Read the password from stdin (one trailing newline stripped)',
      default: false,
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
    // The skill's own rule is "never put a password on a command line", and
    // this command was the one surface that forced it. Same contract as
    // `auth login --password-stdin`.
    if (args['password-stdin'] && args.password !== undefined) {
      throw new Refusal('Pass either --password or --password-stdin, not both.', 'invalid_flags')
    }
    let password: string
    if (args['password-stdin']) {
      if (process.stdin.isTTY) {
        throw new Refusal(
          '--password-stdin expects the password piped on stdin, e.g. `printf %s "$PW" | deepspace test accounts create --email bot@deepspace.test --password-stdin`.',
          'password_stdin_needs_pipe',
        )
      }
      password = (await readStreamText(process.stdin, MAX_STDIN_BYTES)).replace(/\r?\n$/, '')
    } else if (typeof args.password === 'string') {
      password = args.password
    } else {
      throw new Refusal(
        'A password is required: pipe it with --password-stdin (preferred), or pass --password.',
        'missing_password',
      )
    }
    // An unnamed account can never be selected via `users(['Name'])`, so
    // default the selector to the email local-part instead of leaving it unset.
    const name = (args.name as string | undefined) ?? email.split('@')[0]
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

    // Neither surface echoes the password: the caller passed it in with
    // `--password`, it is stored 0600 in TEST_ACCOUNTS_PATH (named below), and
    // `test accounts list --reveal` prints it on request. Repeating it here
    // only put a live credential into every log that captures this command.
    if (!args.json) {
      console.log(`Created test account:`)
      console.log(`  ID:       ${account.id}`)
      console.log(`  Email:    ${account.email}`)
      console.log(`  Selector: ${name}`)
      console.log(`  UserID:   ${account.userId}`)
      if (account.label) console.log(`  Label:    ${account.label}`)
      console.log(`\nSaved to ${TEST_ACCOUNTS_PATH}`)
    }

    return {
      data: {
        id: account.id,
        email: account.email,
        name,
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
  args: {
    usable: {
      type: 'boolean',
      description: 'Only accounts with locally saved credentials (usable by the users() fixture)',
      default: false,
    },
    reveal: {
      type: 'boolean',
      description:
        'Print locally saved passwords instead of masking them (in --json too: without it the `password` field is omitted)',
      default: false,
    },
  },
  async run({ args }) {
    await ensureToken()

    let remote: RemoteTestAccount[]
    try {
      remote = (await syncTestAccountStore()).accounts
    } catch (err) {
      throw new Refusal(`Failed: ${(err as Error).message}`, 'test_accounts_list_failed')
    }

    // Merge the local record: selector name + password never leave this
    // machine, and the users() fixture can only drive accounts whose
    // password is stored here.
    const localByEmail = new Map(loadAllTestAccounts().map((a) => [a.email, a]))
    const accounts = remote
      .map((a) => {
        const stored = localByEmail.get(a.email)
        return {
          id: a.id,
          email: a.email,
          userId: a.userId,
          label: a.label,
          createdAt: a.createdAt,
          name: stored?.name ?? null,
          // A saved password leaves this machine only on request — `--reveal`
          // gates it in `--json` exactly as it does in the human listing.
          ...(args.reveal ? { password: stored?.password ?? null } : {}),
          usableByFixture: Boolean(stored?.password),
        }
      })
      .filter((a) => !args.usable || a.usableByFixture)

    if (accounts.length === 0) {
      if (!args.json) {
        console.log(
          remote.length > 0
            ? `No test accounts with locally saved credentials (${remote.length} remote-only). Recreate them with: deepspace test accounts create --email <email> --password <password>`
            : 'No test accounts. Create one with: deepspace test accounts create --email <email> --password <password>',
        )
      }
      return { data: { accounts: [], count: 0, limit: 10 } }
    }

    if (!args.json) {
      console.log(`Test accounts (${remote.length}/10${args.usable ? ', usable only' : ''}):\n`)
      for (const a of accounts) {
        const date = new Date(a.createdAt).toLocaleDateString()
        console.log(`  ${a.email}${a.label ? ` (${a.label})` : ''}`)
        console.log(`    ID: ${a.id}  UserID: ${a.userId}  Created: ${date}`)
        console.log(`    Selector: ${a.name ?? '(none)'}`)
        if (a.usableByFixture) {
          console.log(`    Password: ${args.reveal ? a.password : '(saved locally)'}`)
        } else {
          console.log(`    Password: (not saved locally — not usable by the users() fixture)`)
        }
      }
    }

    return {
      data: {
        accounts,
        count: accounts.length,
        limit: 10,
      },
    }
  },
})

const del = defineDeepspaceCommand({
  meta: {
    name: 'delete',
    // Deleting ONE named account is unambiguous, so this verb never prompts
    // and has no --yes to skip a prompt with (`clear`, which deletes the whole
    // pool, is the one that confirms). Say so in --help: a teardown script
    // written straight after `app undeploy --yes` otherwise reaches for a flag
    // that does not exist here.
    description: 'Delete a test account by --email or --id (immediate; never prompts)',
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

const recover = defineDeepspaceCommand({
  meta: {
    name: 'recover',
    description: 'Re-issue the local credential for a test account you own',
  },
  args: {
    email: {
      type: 'string',
      description: 'Email of the test account to recover',
      required: false,
    },
    id: {
      type: 'string',
      description: 'ID of the test account to recover',
      required: false,
    },
    all: {
      type: 'boolean',
      description: 'Recover every pool account missing a local credential',
      required: false,
    },
  },
  async run({ args }) {
    const selectors = [args.email, args.id, args.all].filter(Boolean).length
    if (selectors === 0) {
      throw new Refusal('Provide --email <email>, --id <id>, or --all.', 'missing_argument')
    }
    if (selectors > 1) {
      throw new Refusal('Provide exactly one of --email, --id, or --all.', 'conflicting_arguments')
    }

    await ensureToken()

    let remote: RemoteTestAccount[]
    try {
      remote = await fetchRemoteTestAccounts()
    } catch (err) {
      throw new Refusal(`Failed: ${(err as Error).message}`, 'test_accounts_list_failed')
    }

    const localAccounts = loadAllTestAccounts()
    const known = new Set(localAccounts.map((account) => account.id))
    // Display names this machine already knows. Rotation now returns the name
    // off the platform's own user row, so this only covers a platform older
    // than that join; `name` is what a spec compares against, so keep a real
    // one wherever it comes from and never invent one from the address.
    const localNames = new Map(
      localAccounts.flatMap((account) =>
        account.name ? [[account.email, account.name] as const] : [],
      ),
    )
    let targets: RemoteTestAccount[]
    if (args.all) {
      targets = remote.filter((account) => !known.has(account.id))
      if (targets.length === 0) {
        if (!args.json) console.log('Every pool account already has a local credential.')
        return { data: { recovered: [], alreadyLocal: remote.length } }
      }
    } else {
      const match = args.id
        ? remote.find((account) => account.id === args.id)
        : remote.find((account) => account.email === args.email)
      if (!match) {
        throw new Refusal(
          `No test account ${args.id ? `with id ${args.id}` : `with email ${args.email}`} on this account.`,
          'test_account_not_found',
          { action: cliAction('deepspace', 'test', 'accounts', 'list') },
        )
      }
      targets = [match]
    }

    const recovered: Array<{ id: string; email: string }> = []
    const failures: Array<{ email: string; error: string }> = []
    for (const target of targets) {
      try {
        const account = await recoverRemoteTestAccount(target.id)
        const name = account.name ?? localNames.get(account.email)
        upsertTestAccount({
          id: account.id,
          email: account.email,
          password: account.password,
          userId: account.userId,
          label: account.label,
          ...(name ? { name } : {}),
          createdAt: account.createdAt,
        })
        recovered.push({ id: account.id, email: account.email })
      } catch (err) {
        failures.push({ email: target.email, error: (err as Error).message })
      }
    }

    if (failures.length > 0) {
      throw new Refusal(
        `Recovered ${recovered.length}/${targets.length} test account(s).\nFailed:\n` +
          failures.map((failure) => `  ${failure.email}: ${failure.error}`).join('\n'),
        'test_account_recover_failed',
        { extra: { recovered, requested: targets.length, failures } },
      )
    }

    if (!args.json) {
      for (const account of recovered) console.log(`Recovered ${account.email}`)
      console.log(
        `\nStored in ${TEST_ACCOUNTS_PATH}. The previous password (if any machine still holds one) no longer works — recover there too.`,
      )
    }
    return { data: { recovered, requested: targets.length, failures: [] } }
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
    recover,
  },
})
