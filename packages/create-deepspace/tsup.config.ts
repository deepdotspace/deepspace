import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', 'install-worker': 'src/install-worker.ts' },
  format: ['esm'],
  sourcemap: true,
  clean: true,
  external: ['@clack/prompts', /^node:.*/],
  banner: { js: '#!/usr/bin/env node' },
})
