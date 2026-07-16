import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    // Mirror tsup.config.ts — source files import via the '@' alias.
    alias: { '@': resolve(__dirname, 'src') },
  },
  test: {
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
