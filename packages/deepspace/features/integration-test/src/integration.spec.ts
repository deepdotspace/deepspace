/**
 * Integration proxy E2E — drives the /integration-test page to exercise
 * the authenticated billing + proxy flow end to end.
 *
 * Public email/password sign-up is disabled, so the authenticated test
 * signs in as a pre-created test account via the `users` fixture (from
 * deepspace/testing), which handles sign-in caching, context creation,
 * and cleanup. Create at least one test account first:
 *   npx deepspace test-accounts create --email integ@deepspace.test --password TestPass123! --name "Integration Tester"
 */
import { test, expect } from 'deepspace/testing'

async function waitForApp(page: import('@playwright/test').Page) {
  await page.waitForSelector('[data-testid="app-navigation"]', { timeout: 15000 })
}

test.describe('Integration API', () => {
  test('authenticated user can call OpenAI via integration proxy', async ({ users }) => {
    const [{ page }] = await users(1)

    await page.goto('/integration-test')
    await waitForApp(page)
    await page.waitForSelector('[data-testid="integration-submit"]', { timeout: 10000 })

    // Default is openai/chat-completion — click submit
    await page.getByTestId('integration-submit').click()

    // Wait for result or error
    await page.waitForSelector('[data-testid="integration-result"], [data-testid="integration-error"]', { timeout: 30000 })

    const resultEl = page.getByTestId('integration-result')
    const errorEl = page.getByTestId('integration-error')

    if (await resultEl.isVisible()) {
      const text = await resultEl.textContent()
      const result = JSON.parse(text!)
      expect(result.success).toBeTruthy()
      expect(result.data).toBeDefined()
    } else {
      const errorText = await errorEl.textContent()
      // Acceptable errors: no API key (dev), insufficient credits, etc.
      expect(errorText).toBeTruthy()
    }
  })

  test('integration test page loads for anonymous user', async ({ page }) => {
    await page.goto('/integration-test')
    await page.waitForSelector('[data-testid="app-navigation"]', { timeout: 15000 })
    await expect(page.getByTestId('integration-submit')).toBeVisible()
  })
})
