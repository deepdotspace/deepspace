import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  sourcemap: true,
  clean: true,
  external: ['@clack/prompts', /^node:.*/],
  banner: { js: '#!/usr/bin/env node' },
})
