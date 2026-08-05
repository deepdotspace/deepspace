import { describe, expect, it } from 'vitest'
import {
  reconcileTestAccounts,
  reconcileTestAccountScopes,
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

  it('preserves legacy credentials that predate remote ids', () => {
    const local: TestAccount[] = [{ email: live.email, password: 'legacy-secret', name: 'Live' }]

    expect(reconcileTestAccounts(local, [live])).toEqual([
      { ...live, password: 'legacy-secret', name: 'Live' },
    ])
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
      unscoped: [],
    }

    const afterStaging = reconcileTestAccountScopes(initial, [staging], stagingOrigin).store
    const backOnProduction = reconcileTestAccountScopes(
      afterStaging,
      [production],
      productionOrigin,
    )

    expect(backOnProduction.accounts).toEqual([
      { ...production, password: 'production-secret' },
    ])
    expect(backOnProduction.store.scopes[stagingOrigin]).toEqual([
      { ...staging, password: 'staging-secret' },
    ])
  })
})
