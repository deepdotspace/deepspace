/**
 * The browser build of `deepspace/native` (the `browser` export condition):
 * the same names as the native bundle, built from browser modules only, so a
 * React Native app's web export loads no native code.
 */
import { resolve } from 'node:path'
import { build, type Metafile } from 'esbuild'
import { beforeAll, describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '..')
const EXTERNAL = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-native',
  'better-auth',
  'better-auth/react',
  'better-auth/client/plugins',
  'jose',
  'yjs',
]

async function bundle(entry: string, external: string[]): Promise<Metafile> {
  const result = await build({
    entryPoints: [resolve(SRC, entry)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    metafile: true,
    external,
    alias: { '@': SRC },
    logLevel: 'silent',
  })
  return result.metafile as Metafile
}

async function exportsOf(entry: string, external: string[]): Promise<string[]> {
  return Object.values((await bundle(entry, external)).outputs).flatMap((file) => file.exports)
}

let inputs: string[] = []
let imports: string[] = []

beforeAll(async () => {
  const metafile = await bundle('native.web.ts', EXTERNAL)
  inputs = Object.keys(metafile.inputs)
  imports = Object.values(metafile.outputs).flatMap((file) => file.imports.map((entry) => entry.path))
})

describe('deepspace/native in the browser', () => {
  it('loads no native module and no Expo package', () => {
    expect(inputs.filter((input) => /\.native\.tsx?$/.test(input))).toEqual([])
    expect(inputs.some((input) => input.endsWith('src/expo.ts'))).toBe(false)
    expect(imports.filter((path) => path === 'expo' || path.startsWith('expo-'))).toEqual([])
  })

  it('exports exactly the names the native bundle does', async () => {
    const native = await exportsOf('native.ts', [...EXTERNAL, 'expo', 'expo-crypto', 'expo-linking', 'expo-secure-store', 'expo-web-browser'])
    const web = await exportsOf('native.web.ts', EXTERNAL)
    expect([...web].sort()).toEqual([...native].sort())
  })
})
