import { chmodSync, writeFileSync } from 'node:fs'

/**
 * Write a file that holds plaintext secret values (`.dev.vars` caches,
 * `secrets download` output) readable by the owner only. `writeFileSync`'s
 * `mode` applies only when the file is created, so chmod separately to
 * tighten files that already exist with a wider mode.
 */
export function writeSecretFileSync(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // POSIX modes are best-effort on Windows; the write itself succeeded.
  }
}
