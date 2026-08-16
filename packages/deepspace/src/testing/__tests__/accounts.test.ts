import { describe, expect, it } from 'vitest'
import {
  findTestAccountByName,
  reconcileTestAccounts,
  reconcileTestAccountScopes,
  testAccountEmailSlug,
  type RemoteTestAccount,
  type TestAccount,
  type TestAccountCredentialStore,
} from '../accounts'

const live: RemoteTestAccount = {
  id: 'live-id',
  email: 'live@deepspace.test',
  userId: 'live-user',
  label: 'current',
  createdAt: 2,
}

describe('test account registry reconciliation', () => {
  it('removes stale credentials and refreshes remote metadata', () => {
    const local: TestAccount[] = [
      { ...live, password: 'secret', name: 'Live', label: 'old' },
      { id: 'deleted-id', email: 'deleted@deepspace.test', password: 'stale' },
    ]

    expect(reconcileTestAccounts(local, [live])).toEqual([
      { ...live, password: 'secret', name: 'Live' },
    ])
  })

  it('does not reuse a password after an email is recreated with a new id', () => {
    const local: TestAccount[] = [{ ...live, password: 'old-secret' }]
    const recreated = { ...live, id: 'replacement-id', userId: 'replacement-user' }

    expect(reconcileTestAccounts(local, [recreated])).toEqual([])
  })

  it('does not reuse credentials that predate remote ids', () => {
    const local: TestAccount[] = [{ email: live.email, password: 'old-secret', name: 'Live' }]

    expect(reconcileTestAccounts(local, [live])).toEqual([])
  })

  it('preserves passwords while reconciling production, staging, then production', () => {
    const productionOrigin = 'https://auth.deep.space'
    const stagingOrigin = 'https://auth.deepspacesites.com'
    const production = { ...live, id: 'production-id', email: 'prod@deepspace.test' }
    const staging = { ...live, id: 'staging-id', email: 'stage@deepspace.test' }
    const initial: TestAccountCredentialStore = {
      version: 2,
      scopes: {
        [productionOrigin]: [{ ...production, password: 'production-secret' }],
        [stagingOrigin]: [{ ...staging, password: 'staging-secret' }],
      },
    }

    const afterStaging = reconcileTestAccountScopes(initial, [staging], stagingOrigin).store
    const backOnProduction = reconcileTestAccountScopes(
      afterStaging,
      [production],
      productionOrigin,
    )

    expect(backOnProduction.accounts).toEqual([{ ...production, password: 'production-secret' }])
    expect(backOnProduction.store.scopes[stagingOrigin]).toEqual([
      { ...staging, password: 'staging-secret' },
    ])
  })
})

describe('testAccountEmailSlug', () => {
  it('turns a display name into a runnable email local-part', () => {
    // The not-found hint used to lowercase the name straight into an address,
    // so "Collab A" produced `--email collab a@deepspace.test` — a command
    // that cannot run because of the space.
    expect(testAccountEmailSlug('Collab A')).toBe('collab-a')
    expect(`${testAccountEmailSlug('Collab A')}@deepspace.test`).not.toMatch(/\s/)
  })

  it('collapses punctuation and trims separators', () => {
    expect(testAccountEmailSlug("O'Brien  (QA)")).toBe('o-brien-qa')
    expect(testAccountEmailSlug('  Ada  ')).toBe('ada')
  })

  it('falls back rather than emitting an empty local-part', () => {
    expect(testAccountEmailSlug('***')).toBe('tester')
  })
})

describe('findTestAccountByName failure', () => {
  // Reads the developer's real credential store, so use a display name no
  // pool account would ever carry — the assertion is about the message, and
  // it must not depend on which machine runs it.
  const ABSENT = 'Absent Fixture Account 9f3c'

  it('suggests a runnable command and the recovery path', () => {
    let message = ''
    try {
      findTestAccountByName(ABSENT)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }

    const suggested = message.match(/--email (\S+)/)?.[1]
    expect(suggested).toBe('absent-fixture-account-9f3c@deepspace.test')
    expect(suggested).not.toMatch(/\s/)
    // The pool is global but passwords are local-only, so "not found here"
    // very often means "created on another machine" — say so.
    expect(message).toContain('deepspace test accounts recover')
  })
})
