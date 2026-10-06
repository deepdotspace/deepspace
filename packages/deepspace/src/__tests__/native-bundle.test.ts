/**
 * Proves the `deepspace/native` bundle is isolated from the browser client:
 * it is built with the same plugin and externals as tsup.config.ts, then its
 * module graph and output are checked for browser-only code.
 */
import { resolve } from 'node:path'
import { build, type Metafile } from 'esbuild'
import { beforeAll, describe, expect, it } from 'vitest'
import { nativeModuleCandidate, preferNativeModules } from '../native/build-plugin'

const SRC = resolve(__dirname, '..')
const EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-native',
  'expo-crypto',
  'expo-linking',
  'expo-secure-store',
  'expo-web-browser',
]

let output = ''
let inputs: string[] = []
let imports: string[] = []

beforeAll(async () => {
  const result = await build({
    entryPoints: [resolve(SRC, 'native.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    metafile: true,
    external: EXTERNAL,
    alias: { '@': SRC },
    plugins: [preferNativeModules(SRC)],
    logLevel: 'silent',
  })
  output = result.outputFiles[0].text
  const metafile = result.metafile as Metafile
  inputs = Object.keys(metafile.inputs)
  imports = Object.values(metafile.outputs).flatMap((file) =>
    file.imports.map((entry) => entry.path),
  )
})

describe('deepspace/native bundle', () => {
  it('substitutes the native auth, origin and foreground modules', () => {
    for (const nativeModule of [
      'client/auth/index.native.ts',
      'client/auth/token.native.ts',
      'client/platform/origin.native.ts',
      'client/platform/foreground.native.ts',
    ]) {
      expect(inputs.some((input) => input.endsWith(nativeModule))).toBe(true)
    }
    for (const browserModule of [
      'client/auth/index.ts',
      'client/auth/token.ts',
      'client/auth/client.ts',
      'client/auth/AuthOverlay.tsx',
      'client/platform/origin.ts',
      'client/platform/foreground.ts',
    ]) {
      expect(inputs.some((input) => input.endsWith(browserModule))).toBe(false)
    }
  })

  it('imports only React, React Native and the Expo modules', () => {
    expect(new Set(imports)).toEqual(new Set(imports.filter((path) => EXTERNAL.includes(path))))
    expect(imports).toContain('react-native')
    for (const forbidden of ['react-dom', 'better-auth', 'lucide-react', 'yjs', 'hono']) {
      expect(imports.some((path) => path.startsWith(forbidden))).toBe(false)
    }
  })

  it('never reads browser-only globals', () => {
    // React Native has no window.location, document or navigator.onLine, and
    // no web storage. The only permitted touches are optional reads off
    // globalThis (the debug flag), which are absent on native.
    expect(output).not.toMatch(/\bwindow\b/)
    expect(output).not.toMatch(/\bdocument\b/)
    expect(output).not.toMatch(/\bnavigator\b/)
    expect(output).not.toMatch(/\bsessionStorage\b/)
    expect(output.match(/\blocalStorage\b[^?]/g) ?? []).toEqual([])
    expect(output.match(/\blocation\b[^?]/g) ?? []).toEqual([])
  })

  it('prefers a .native sibling and leaves other modules alone', () => {
    expect(nativeModuleCandidate(resolve(SRC, 'client/auth/token.ts'))).toBe(
      resolve(SRC, 'client/auth/token.native.ts'),
    )
    expect(nativeModuleCandidate(resolve(SRC, 'client/auth/token.native.ts'))).toBeNull()
    expect(nativeModuleCandidate(resolve(SRC, 'client/storage/store.ts'))).toBeNull()
  })
})
