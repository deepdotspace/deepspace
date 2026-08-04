/**
 * Test-side mirror of create-deepspace's template assembly (see
 * packages/create-deepspace/src/index.ts `assembleTemplate`): a scaffolded
 * app is the shared `templates/base/` tree with the chosen overlay
 * `templates/<name>/` copied on top (overlay wins; `template.json` is
 * metadata, never shipped). Kept in ONE helper so every test that needs a
 * "real" scaffolded app builds it the same way.
 */
import { cpSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// __tests__ → commands → cli → src → <package root>
const PKG_ROOT = resolve(here, '..', '..', '..', '..')
export const TEMPLATES_DIR = resolve(PKG_ROOT, '..', 'create-deepspace', 'templates')
export const FEATURES_DIR = resolve(PKG_ROOT, 'features')

/** All selectable overlays (every templates/ dir except the shared base). */
export function listOverlays(): string[] {
  return readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'base')
    .map((e) => e.name)
    .sort()
}

/** Assemble base + overlay into destDir, exactly as the scaffolder does. */
export function assembleTemplate(overlay: string, destDir: string): void {
  cpSync(join(TEMPLATES_DIR, 'base'), destDir, { recursive: true })
  const overlayDir = join(TEMPLATES_DIR, overlay)
  for (const entry of readdirSync(overlayDir)) {
    if (entry === 'template.json') continue
    cpSync(join(overlayDir, entry), join(destDir, entry), { recursive: true })
  }
  if (overlay === 'copilot') {
    for (const [source, destination] of [
      ['ChatPanel.tsx', 'src/components/chat/ChatPanel.tsx'],
      ['ChatPanel.messages.tsx', 'src/components/chat/ChatPanel.messages.tsx'],
      ['ChatPanel.stream.ts', 'src/components/chat/ChatPanel.stream.ts'],
      ['ai-chat-schema.ts', 'src/schemas/ai-chat-schema.ts'],
    ] as const) {
      const target = join(destDir, destination)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(join(FEATURES_DIR, 'ai-chat', 'src', source), target)
    }
  }
}
