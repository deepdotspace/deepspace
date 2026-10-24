import { test, expect } from '@playwright/test'
test('auth service is reachable', async ({ request }) => {
  expect((await request.get('/api/auth/ok')).ok()).toBeTruthy()
})
