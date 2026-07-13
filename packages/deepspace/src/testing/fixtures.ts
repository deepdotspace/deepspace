/**
 * Multi-user Playwright fixture for DeepSpace apps.
 *
 * Usage:
 *
 *   import { test, expect } from 'deepspace/testing'
 *
 *   test('A sends, B sees', async ({ users }) => {
 *     const [a, b] = await users(2)
 *     await a.page.goto('/chat')
 *     await b.page.goto('/chat')
 *     await a.page.getByTestId('message-input').fill('hi')
 *     await a.page.getByTestId('send-message-btn').click()
 *     await expect(b.page.getByText('hi')).toBeVisible()
 *   })
 *
 * `users(N)` picks the first N test accounts from
 * `~/.deepspace/test-accounts.json` (created via
 * `deepspace test-accounts create`). `users(['Alice', 'Bob'])` picks
 * specific accounts by name.
 *
 * Each user gets a separate browser context with cached storageState
 * (per-account JSON in `~/.deepspace/playwright-states/`). Sign-in
 * happens once per account, not once per test, sidestepping Better
 * Auth's per-IP rate limit on `/api/auth/sign-in/email`.
 *
 * Contexts are auto-closed when the test finishes.
 */

import { test as baseTest, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  type TestAccount,
  pickTestAccounts,
  findTestAccountByName,
} from './accounts'
import { ensureStorageState } from './storage-state'

export interface MultiplayerUser {
  context: BrowserContext
  page: Page
  email: string
  name: string
  /** Test account user ID, if known from the accounts registry. */
  userId?: string
}

/**
 * Fixture function signature. Pass either a count (`users(2)`) or an
 * array of account names (`users(['Alice', 'Bob'])`). Returns one entry
 * per requested user.
 */
export type UsersFixture = (
  selector: number | string[],
  options?: { label?: string },
) => Promise<MultiplayerUser[]>

interface MultiplayerFixtures {
  users: UsersFixture
}

async function buildUser(
  browser: Browser,
  account: TestAccount,
  baseURL: string,
): Promise<{ user: MultiplayerUser; cleanup: () => Promise<void> }> {
  const statePath = await ensureStorageState(browser, account, baseURL)
  const context = await browser.newContext({ storageState: statePath, baseURL })
  const page = await context.newPage()
  return {
    user: {
      context,
      page,
      email: account.email,
      name: account.name ?? account.email.split('@')[0],
      userId: account.userId,
    },
    cleanup: async () => {
      await context.close()
    },
  }
}

export const test = baseTest.extend<MultiplayerFixtures>({
  users: async ({ browser, baseURL }, use) => {
    if (!baseURL) {
      throw new Error(
        '`users` fixture requires a baseURL. Set it on your Playwright config ' +
          '(e.g. `use: { baseURL: "http://localhost:5173" }`) or via the ' +
          'webServer.url shortcut.',
      )
    }

    const cleanups: Array<() => Promise<void>> = []

    const usersFn: UsersFixture = async (selector, options) => {
      const accounts: TestAccount[] = Array.isArray(selector)
        ? selector.map((name) => findTestAccountByName(name))
        : pickTestAccounts(selector, options)

      const built = await Promise.all(
        accounts.map((acct) => buildUser(browser, acct, baseURL)),
      )
      for (const b of built) cleanups.push(b.cleanup)
      return built.map((b) => b.user)
    }

    await use(usersFn)

    // Tear down any contexts we created. Errors are swallowed — a test
    // failure shouldn't be masked by a cleanup error.
    for (const cleanup of cleanups) {
      await cleanup().catch(() => {})
    }
  },
})

export { expect } from '@playwright/test'
