import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: [
      // Mirror tsup.config.ts — source files import via the '@' alias.
      { find: '@', replacement: resolve(__dirname, 'src') },
      // Feature-source tests import the same public surface installed apps do.
      // Resolve it to source so a clean checkout does not require dist/ first.
      { find: /^deepspace$/, replacement: resolve(__dirname, 'src/index.ts') },
      { find: /^deepspace\/worker$/, replacement: resolve(__dirname, 'src/worker.ts') },
    ],
  },
  test: {
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'features/**/__tests__/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Real-git suites must never touch the developer's own git config.
    setupFiles: ['./vitest.setup.ts'],
    maxWorkers: 4,
    // The CLI suites are process-spawning integration tests (real git against
    // real repos). Their per-test P99 under a full `pnpm check` legitimately
    // exceeds vitest's 5s default — measured: three >5s timeouts across two
    // forced gate runs, unchanged by worker caps — so the budget matches the
    // workload class, same as deploy-worker's config and for the same reason.
    testTimeout: 20_000,
  },
})
