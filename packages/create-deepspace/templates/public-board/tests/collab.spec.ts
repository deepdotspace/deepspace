import { test, expect } from '@playwright/test'
test('anonymous browsers share confirmed writes', async ({ browser, baseURL }) => {
  const first = await browser.newContext({ baseURL })
  const second = await browser.newContext({ baseURL })
  try {
    const a = await first.newPage(),
      b = await second.newPage()
    await a.goto('/')
    await b.goto('/')
    const text = `Shared ${Date.now()}`
    await a.getByLabel('New idea').fill(text)
    await a.getByRole('button', { name: 'Add idea' }).click()
    const name = `Complete ${text}`
    await expect(b.getByRole('checkbox', { name, exact: true })).toBeVisible()
    // The checkbox flips only after the server confirms, so click and wait.
    await b.getByRole('checkbox', { name, exact: true }).click()
    await expect(b.getByRole('checkbox', { name, exact: true })).toBeChecked()
    await expect(a.getByRole('checkbox', { name, exact: true })).toBeChecked()
  } finally {
    await first.close()
    await second.close()
  }
})
