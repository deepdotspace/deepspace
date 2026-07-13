import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.wrangler', '.vite'])

/**
 * Delete macOS metadata files (AppleDouble `._*` and `.DS_Store`) under an
 * app directory. They appear when a project is copied from macOS through
 * tar/zip/SMB onto another system, and they poison the toolchain: ESLint
 * hard-fails on their binary content ("Parsing error: Invalid character",
 * failing the deploy lint), and generouted can pick up `._index.tsx` in
 * src/pages as a phantom route. Returns the number of files removed.
 */
export function removeMacosJunk(dir: string): number {
  let removed = 0
  // Best-effort throughout: an unreadable subdir or undeletable file must
  // never abort a build that would otherwise have worked.
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return removed
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) removed += removeMacosJunk(path)
      continue
    }
    if (entry.name === '.DS_Store' || entry.name.startsWith('._')) {
      try {
        rmSync(path, { force: true })
        removed++
      } catch {
        // Leave it — the lint may still trip on it, but we didn't make
        // anything worse.
      }
    }
  }
  return removed
}
