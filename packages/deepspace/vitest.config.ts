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
  },
})
