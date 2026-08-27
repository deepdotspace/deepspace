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
    // exceeds vitest's 5s default, and 0.27.0's ~20 added real-git tests
    // pushed the heaviest files past the old 20-30s caps under full-suite
    // worker contention (~5s solo, ~35s parallel — deterministic timeouts on
    // an otherwise idle machine, not hangs). One budget HERE, not per-file
    // vi.setConfig raises scattered as each file tips over: 60s per test,
    // 30s per hook (vi.setConfig never covers hooks, and the real-git
    // beforeAll in git-repository.test.ts ran on vitest's 10s default).
    // Headroom, not a license to hang.
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Console output from PASSING tests is noise that buries real failures
    // in gate logs; failing tests keep their full output.
    silent: 'passed-only',
  },
})
