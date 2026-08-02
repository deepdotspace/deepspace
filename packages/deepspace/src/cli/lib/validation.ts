/**
 * The project's own check, run locally — the machinery behind
 * `deepspace workspace land --validate`.
 *
 * A validation is a pure LOCAL GATE: it runs the project's check against the
 * merged tree and aborts the land on failure. Nothing is recorded anywhere —
 * "tests were green" is a fact about a tree, and the tree is right here.
 */

import { sync as spawnSync } from 'cross-spawn'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectPackageManager } from './package-manager'

const MAX_SUMMARY_CHARS = 4_000
const MAX_OUTPUT_BUFFER = 64 * 1024 * 1024

/** The script runner matching the repo's lockfile (npm unless proven otherwise). */
function configuredCommand(appDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>
    }
    if (pkg.scripts?.validate) return `${detectPackageManager(appDir)} run --silent validate`
  } catch {
    // no/broken package.json — handled by the caller's advice
  }
  return null
}

export interface ValidationRun {
  passed: boolean
  durationMs: number
  summary: string | null
  output: string
  exitStatus: number | null
}

/** Resolve the validation command: an explicit override, else the package.json
 *  `validate` script (via the repo's package runner), else null. */
export function resolveValidationCommand(appDir: string, explicit?: string): string | null {
  return explicit?.trim() || configuredCommand(appDir)
}

/** Run a validation command and capture its outcome. Never throws on a non-zero
 *  exit — a failed check is a well-formed result the caller turns into its own
 *  refusal. */
export function runValidationCommand(appDir: string, command: string): ValidationRun {
  const started = Date.now()
  const res = spawnSync(command, [], {
    cwd: appDir,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_OUTPUT_BUFFER,
    env: { ...process.env, CI: process.env.CI ?? '1' },
  })
  const durationMs = Date.now() - started
  const passed = res.status === 0 && !res.error
  const output =
    `${res.stdout?.toString('utf-8') ?? ''}\n${res.stderr?.toString('utf-8') ?? ''}`.trim()
  const summary = output.slice(-MAX_SUMMARY_CHARS) || (res.error ? res.error.message : null)
  return { passed, durationMs, summary, output, exitStatus: res.status ?? null }
}
