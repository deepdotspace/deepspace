import { defineConfig } from 'tsup'
import { resolve } from 'path'

const alias = { '@': resolve(__dirname, 'src') }

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    external: [
      'react', 'react-dom', 'react/jsx-runtime',
      'better-auth', 'better-auth/react', 'better-auth/client/plugins',
      'jose', 'yjs', 'hono', 'zustand',
      'lucide-react', 'framer-motion', 'react-router-dom',
      'clsx', 'tailwind-merge',
    ],
    esbuildOptions(options) {
      options.jsx = 'automatic'
      options.alias = alias
    },
  },
  {
    entry: { worker: 'src/worker.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    external: [
      'better-auth', 'better-auth/plugins',
      'jose', 'yjs', 'hono',
      'ai', '@ai-sdk/anthropic', '@ai-sdk/openai', '@ai-sdk/openai-compatible',
      /^cloudflare:.*/, /^node:.*/,
    ],
    esbuildOptions(options) {
      options.alias = alias
    },
  },
  {
    entry: { cli: 'src/cli/cli.ts' },
    format: ['esm'],
    sourcemap: true,
    external: ['citty', '@clack/prompts', /^node:.*/],
    banner: { js: '#!/usr/bin/env node' },
    esbuildOptions(options) {
      options.alias = alias
    },
  },
  {
    entry: { testing: 'src/testing/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    external: ['@playwright/test', /^node:.*/],
    esbuildOptions(options) {
      options.alias = alias
    },
  },
  // Server entry: helpers app authors import inside their own worker
  // (refundInvoice, requireSubscription, room handlers, etc.). Docs reference
  // `import { ... } from 'deepspace/server'`, so this also needs a matching
  // `exports['./server']` in package.json.
  {
    entry: { server: 'src/server/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    external: [
      'better-auth', 'better-auth/plugins',
      'jose', 'yjs', 'hono',
      'ai', '@ai-sdk/anthropic', '@ai-sdk/openai', '@ai-sdk/openai-compatible',
      /^cloudflare:.*/, /^node:.*/,
    ],
    esbuildOptions(options) {
      options.alias = alias
    },
  },
])
