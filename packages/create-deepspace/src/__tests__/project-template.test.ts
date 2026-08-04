import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { assembleTemplate, resolveDeepSpaceFeatureDirectory } from '../project-template'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sdkFeatureRoot = resolve(packageRoot, '..', 'deepspace', 'features', 'ai-chat', 'src')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('project template assembly', () => {
  it('resolves canonical feature sources from an isolated packed creator', () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), 'create-deepspace-packed-'))
    temporaryDirectories.push(isolatedRoot)
    const sourceDirectory = join(isolatedRoot, 'package', 'dist')
    const bundledFeature = join(sourceDirectory, 'features', 'ai-chat')
    mkdirSync(bundledFeature, { recursive: true })

    expect(resolveDeepSpaceFeatureDirectory('ai-chat', sourceDirectory)).toBe(bundledFeature)
  })

  it('assembles editable copilot chat files from the canonical SDK feature', () => {
    const output = mkdtempSync(join(tmpdir(), 'create-deepspace-copilot-'))
    temporaryDirectories.push(output)
    assembleTemplate('copilot', output)

    for (const [source, destination] of [
      ['ChatPanel.tsx', 'src/components/chat/ChatPanel.tsx'],
      ['ChatPanel.messages.tsx', 'src/components/chat/ChatPanel.messages.tsx'],
      ['ChatPanel.stream.ts', 'src/components/chat/ChatPanel.stream.ts'],
      ['ai-chat-schema.ts', 'src/schemas/ai-chat-schema.ts'],
    ] as const) {
      expect(readFileSync(join(output, destination), 'utf8')).toBe(
        readFileSync(join(sdkFeatureRoot, source), 'utf8'),
      )
      expect(existsSync(join(packageRoot, 'templates', 'copilot', destination))).toBe(false)
    }
  })

  it('keeps client-consumed schemas on the browser-safe SDK entry', () => {
    const output = mkdtempSync(join(tmpdir(), 'create-deepspace-base-'))
    temporaryDirectories.push(output)
    assembleTemplate('starter', output)

    const usersSchema = readFileSync(join(output, 'src/schemas/users-schema.ts'), 'utf8')
    expect(usersSchema).toContain("from 'deepspace'")
    expect(usersSchema).not.toContain("from 'deepspace/worker'")
  })

  it('splits application routes by default', () => {
    const output = mkdtempSync(join(tmpdir(), 'create-deepspace-base-'))
    temporaryDirectories.push(output)
    assembleTemplate('starter', output)

    const entry = readFileSync(join(output, 'src/main.tsx'), 'utf8')
    const viteConfig = readFileSync(join(output, 'vite.config.ts'), 'utf8')
    expect(entry).toContain("from '@generouted/react-router/lazy'")
    expect(entry).toContain('rootRoute.HydrateFallback = InitialRouteFallback')
    expect(viteConfig).toContain("include: ['@generouted/react-router/lazy']")
  })
})
