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
      'react',
      'react-dom',
      'react/jsx-runtime',
      'better-auth',
      'better-auth/react',
      'better-auth/client/plugins',
      'jose',
      'yjs',
      'hono',
      'lucide-react',
      'framer-motion',
      'react-router-dom',
      'clsx',
      'tailwind-merge',
    ],
    esbuildOptions(options) {
      options.jsx = 'automatic'
      options.alias = alias
    },
  },
  {
    // The public docs primitives and compiler-only hydration/SSR entries share
    // chunks so a custom docs.tsx never carries a second copy of the shell.
    entry: {
      'docs-client-core': 'src/docs/runtime/client.tsx',
      'docs-react': 'src/docs/runtime/public.tsx',
      'docs-server-core': 'src/docs/runtime/server.tsx',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    external: ['react', 'react-dom', 'react-dom/client', 'react-dom/server', 'react/jsx-runtime'],
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
      'better-auth',
      'better-auth/plugins',
      'jose',
      'yjs',
      'hono',
      'ai',
      '@ai-sdk/anthropic',
      '@ai-sdk/openai',
      '@ai-sdk/openai-compatible',
      /^cloudflare:.*/,
      /^node:.*/,
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
    // `add` imports this exact entry from the target app's installed SDK so
    // feature mutations always use that app-pinned catalog and installer.
    entry: { 'feature-installer': 'src/cli/commands/feature-installer.ts' },
    format: ['esm'],
    sourcemap: true,
    external: [/^node:.*/],
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
  {
    // Node-side public docs compiler. Kept out of the browser/worker entries so
    // filesystem and parser dependencies never enter customer runtime bundles.
    entry: { docs: 'src/docs/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    external: [/^node:.*/],
    esbuildOptions(options) {
      options.alias = alias
    },
  },
  {
    // Hydrates the server-rendered Orbit surface. This is deliberately a
    // standalone IIFE so generated docs need no app framework or CDN runtime.
    entry: { 'docs-runtime': 'src/docs/runtime/auto-client.tsx' },
    format: ['iife'],
    platform: 'browser',
    dts: false,
    minify: true,
    sourcemap: false,
    splitting: false,
    outExtension: () => ({ js: '.js' }),
    define: { 'process.env.NODE_ENV': '"production"' },
    esbuildOptions(options) {
      options.jsx = 'automatic'
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
      'better-auth',
      'better-auth/plugins',
      'jose',
      'yjs',
      'hono',
      'ai',
      '@ai-sdk/anthropic',
      '@ai-sdk/openai',
      '@ai-sdk/openai-compatible',
      /^cloudflare:.*/,
      /^node:.*/,
    ],
    esbuildOptions(options) {
      options.alias = alias
    },
  },
])
